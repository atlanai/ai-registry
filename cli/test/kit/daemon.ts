import { mkdir, writeFile } from "node:fs/promises";
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

/** So `account.login` can resolve the alias against the user's own manifest. */
export async function declareUserRegistry(scope: string, alias = "personal"): Promise<void> {
  await mkdir(scope, { recursive: true });
  await writeFile(
    join(scope, "manifest.yml"),
    ["registries:", `  ${alias}:`, `    source: ${ENDPOINT}`, "    adapter: dev", ""].join("\n"),
  );
}

/** Publishes a skill into the dev adapter's remote folder, as another machine would. */
export async function publishUpstream(remote: string, name: string, body: string): Promise<void> {
  const path = join(remote, NAMESPACE, "skill", name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Reviews a change.\n---\n\n${body}\n`,
  );
  await writeFile(
    join(path, "meta.json"),
    `${JSON.stringify({ id: `skill_${name}`, description: "Reviews a change." })}\n`,
  );
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
