import { dirname } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { NAME } from "#core/product.ts";
import { EMPTY_RUN_COUNTS, type RunEvent, RunEventType, type RunRecord } from "#core/run/model.ts";
import { Printer } from "#core/term/printer.ts";
import type { RpcClient } from "#daemon/rpc/client.ts";
import { privateDirectory, rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { PROTOCOL_VERSION } from "#daemon/rpc/methods.ts";
import { RpcServer } from "#daemon/rpc/server.ts";
import { test } from "#test/kit/fixtures.ts";
import { runs } from "./runs.ts";

// The test serves the socket itself, so no daemon is started or stopped.
vi.mock("#daemon/process/lifecycle.ts", async () => {
  const { cliClient, RpcClient } = await import("#daemon/rpc/client.ts");
  return {
    withDaemon: async <T>(work: (client: RpcClient) => Promise<T>) => {
      const client = await RpcClient.connect(rpcEndpoint(), cliClient("test"));
      try {
        return await work(client);
      } finally {
        client.close();
      }
    },
  };
});

const RUN_ID = "run_00000000-0000-4000-8000-000000000001";

const record: RunRecord = {
  id: RUN_ID,
  jobId: "job_1",
  accountId: "acc_1",
  configRevision: 1,
  mode: "sync",
  trigger: "manual",
  state: "running",
  step: "pull",
  requestedAtMs: 1_000,
  startedAtMs: 1_000,
  deadlineAtMs: 9_000,
  finishedAtMs: undefined,
  counts: EMPTY_RUN_COUNTS,
} as unknown as RunRecord;

function event(id: number, eventType: RunEventType = RunEventType.Progress): RunEvent {
  return {
    id,
    runId: RUN_ID,
    seq: id,
    occurredAtMs: 1_000 + id,
    eventType,
    step: "pull",
    artifact: `a${id}`,
    retryable: false,
  } as unknown as RunEvent;
}

let home: string;
let server: RpcServer;
let printed: unknown[];

function context(argv: string[]): CommandContext {
  return {
    argv,
    cwd: home,
    printer: new Printer({
      format: "json",
      out: {
        write: (chunk: string) => {
          for (const line of chunk.split("\n")) if (line !== "") printed.push(JSON.parse(line));
          return true;
        },
        isTTY: false,
      },
    }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  } as CommandContext;
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  vi.stubEnv("AIREG_HOME", home);
  printed = [];
  server = new RpcServer();
  server.method("initialize", async () => ({
    protocolVersion: PROTOCOL_VERSION,
    server: { name: NAME, version: "test" },
    daemon: { instanceId: "daemon_1", startedAtMs: 1_000, serverNowMs: 2_000, stopping: false },
  }));
  server.method("run.get", async () => ({ run: record }));
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
});

async function listen(): Promise<void> {
  await privateDirectory(dirname(rpcEndpoint()));
  await server.listen(rpcEndpoint());
}

describe.skipIf(process.platform === "win32")("aireg job runs <id>", () => {
  test("answers with the run and its events together when not following", async () => {
    server.method("run.events", async () => ({ events: [event(1), event(2)], hasMore: false }));
    await listen();

    await runs(context([]), RUN_ID, {});

    expect(printed).toEqual([{ ok: true, data: { run: record, events: [event(1), event(2)] } }]);
  });

  test("prints each event once when following, whether replayed or live", async () => {
    server.method("run.events", async () => {
      // Arrives while the replay is still going, and again after it.
      server.broadcast("run.event", event(2));
      return { events: [event(1), event(2)], hasMore: false };
    });
    await listen();

    const following = runs(context([]), RUN_ID, { follow: true });
    await vi.waitFor(() => expect(printed).toHaveLength(2));
    server.broadcast("run.event", event(2));
    server.broadcast("run.event", event(3));
    server.broadcast("run.event", event(4, RunEventType.Finished));
    await following;

    expect(printed.map((line) => (line as { data: { event: RunEvent } }).data.event.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe.skipIf(process.platform === "win32")("aireg job runs --job", () => {
  test("asks for the runs of the job a name names, by its id", async () => {
    await writeConfig(
      {
        ...emptyRegistryConfig(),
        accounts: [{ id: "acc_1", registry: "acme" }],
        jobs: [
          {
            id: "job_1",
            name: "nightly",
            account: "acc_1",
            schedule: { every: 300, enabled: true },
            steps: [
              {
                name: "pull",
                kind: "pull",
                needs: [],
                root: "/",
                select: [],
                policy: "on",
                extra: {},
              },
            ],
          },
        ],
      },
      0,
    );
    const asked: unknown[] = [];
    server.method("run.list", async (params) => {
      asked.push(params);
      return { runs: [record] };
    });
    await listen();

    await runs(context([]), undefined, { job: "nightly" });

    expect(asked).toEqual([{ jobId: "job_1" }]);
    expect(printed).toEqual([{ ok: true, data: { runs: [record] } }]);
  });
});
