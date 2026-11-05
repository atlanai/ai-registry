import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { readConfig } from "#core/config/repository.ts";
import type { RunRecord } from "#core/run/model.ts";
import type { RpcClient } from "#daemon/rpc/client.ts";
import type { ClientInfo } from "#daemon/rpc/methods.ts";
import { type WatchStatus, watchStatus } from "#engine/sync/status.ts";
import { workOf } from "#engine/sync/work.ts";

export const ADAPTER = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/adapter.mjs",
);
export const ENDPOINT = "http://dev.registry.localhost";
export const NAMESPACE = "personal";

export function testClient(instanceId: string): ClientInfo {
  return { kind: "cli", name: "aireg-test", version: "test", instanceId };
}

/** What a job's next sync would do, read in process the way its runner reads it. */
export async function jobStatus(jobId: string): Promise<WatchStatus> {
  const config = await readConfig();
  const job = config.jobs.find(({ id }) => id === jobId);
  const account = config.accounts.find(({ id }) => id === job?.account);
  if (job === undefined || account === undefined) throw new Error(`No job ${jobId}.`);
  return watchStatus(workOf(job), account, new AbortController().signal);
}

export function terminal(run: RunRecord): boolean {
  return run.state !== "queued" && run.state !== "running";
}

export function wait<T>(what: string, poll: () => Promise<T | undefined>): Promise<T> {
  return vi.waitFor(
    async () => {
      const value = await poll();
      if (value === undefined) throw new Error(`${what} did not settle`);
      return value;
    },
    { timeout: 15_000, interval: 25 },
  );
}

export async function finished(client: RpcClient, runId: string): Promise<RunRecord> {
  return wait("Run", async () => {
    const { run } = await client.request("run.get", { runId });
    return terminal(run) ? run : undefined;
  });
}
