import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import type { RunRecord } from "#core/run/model.ts";
import type { RpcClient } from "#daemon/rpc/client.ts";
import { ADAPTER, ENDPOINT, terminal, testClient, wait } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";

const CLIENT = testClient("adapter_job_test");

async function scheduled(client: RpcClient, jobId: string): Promise<RunRecord> {
  return wait("Scheduled run", async () => {
    const { runs } = await client.request("run.list", { jobId });
    return runs.length > 0 && runs.every(terminal) ? runs[0] : undefined;
  });
}

describe("adapter jobs", () => {
  test("runs an adapter's step on the schedule, in the ordinary run mode", async ({
    tmp,
    home,
    daemon,
  }) => {
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await mkdir(home.scope, { recursive: true });
    await writeFile(
      join(home.scope, "manifest.yml"),
      ["registries:", "  personal:", `    source: ${ENDPOINT}`, "    adapter: dev", ""].join("\n"),
    );
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(CLIENT);
    const { account } = await client.request("account.login", { registry: "personal" });
    const before = await client.request("state.snapshot", {});
    const created = await client.request("job.create", {
      type: "probe",
      expectedRevision: before.config.revision,
      account: account.id,
      name: "watch_probe",
      intervalSeconds: 3600,
    });
    expect(created.job.steps.map((step: { kind: string }) => step.kind)).toEqual(["probe"]);

    const run = await scheduled(client, "watch_probe");
    expect(run.mode).toBe("sync");
    expect(run.state).toBe("succeeded");

    // An adapter's step is a step like any other, so the run mode is the
    // run's, never the kind's.
    const manual = await client.request("run.start", {
      jobId: "watch_probe",
      mode: "sync",
    });
    const settled = await wait("Manual run", async () => {
      const { run: latest } = await client.request("run.get", { runId: manual.run.id });
      return terminal(latest) ? latest : undefined;
    });
    expect(settled.state).toBe("succeeded");
  });
});
