import { afterEach, describe, expect, vi } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { RunEventType } from "#core/run/model.ts";
import { Printer } from "#core/term/printer.ts";
import { test } from "#test/kit/fixtures.ts";
import { run } from "./resolve.ts";

const daemon = vi.hoisted(() => ({ withDaemon: vi.fn() }));
vi.mock("#daemon/process/lifecycle.ts", () => daemon);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("aireg sync resolve --job", () => {
  test("runs it on the job's id and prints how it ended as one JSON document", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
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
    const counts = { examined: 1, changed: 1, skipped: 0, attention: 0, failed: 0 };
    const finished = { id: "run_1", state: "succeeded", counts };
    const ended = { id: 1, runId: "run_1", eventType: RunEventType.Finished, data: {} };
    const answers: Record<string, unknown> = {
      "conflict.resolve": { run: { id: "run_1", state: "queued" } },
      "run.events": { events: [ended], hasMore: false },
      "run.get": { run: finished },
    };
    daemon.withDaemon.mockImplementation((work: (client: unknown) => unknown) =>
      work({
        request: async (method: string, params: unknown) => {
          if (method === "conflict.resolve") asked.push(params);
          return answers[method];
        },
        onNotification: () => () => {},
        onClose: () => () => {},
      }),
    );
    const out: string[] = [];
    const context = {
      argv: ["pr-review", "--theirs", "--job", "nightly"],
      cwd: tmp,
      printer: new Printer({
        format: "json",
        out: { write: (text: string) => out.push(text), isTTY: false },
      }),
    } as unknown as CommandContext;

    await run(context);

    expect(asked).toEqual([
      expect.objectContaining({ jobId: "job_1", name: "pr-review", resolution: "theirs" }),
    ]);
    // The run is waited for, so the answer is how it ended.
    expect(JSON.parse(out.join(""))).toEqual({ ok: true, data: { run: finished, artifacts: [] } });
  });
});
