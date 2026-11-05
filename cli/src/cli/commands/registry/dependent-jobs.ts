import { list as listOf } from "#adapter/text.ts";
import { jobScope } from "#cli/commands/job/find.ts";
import { underHome } from "#cli/render/home.ts";
import { unwatchCommand, watchedFolders } from "#core/config/jobs.ts";
import { isScopeStep, type Job, type RegistryConfig } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/realpath.ts";
import type { Roots } from "#core/store/paths.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

const jobName = (job: Job) => job.name ?? job.id;

/**
 * The jobs in this scope that go with the registry, which cannot outlive it. A job set up for
 * more than syncing, such as one that publishes your folders, is refused rather than removed.
 */
export function registryJobs(config: RegistryConfig, alias: string, scope: Roots): Job[] {
  const accounts = new Set(
    config.accounts.filter((account) => account.registry === alias).map((account) => account.id),
  );
  const here = canonical(scope.manifest);
  const jobs = config.jobs.filter((job) => jobScope(job) === here && uses(job, alias, accounts));
  const kept = jobs.find((job) => !syncsOnly(job));
  if (kept !== undefined) {
    const own = kept.steps.filter((step) => !isScopeStep(step)).map((step) => step.kind);
    const does = own.length === 0 ? "publish your folders" : `run ${listOf([...new Set(own)])}`;
    const folders = watchedFolders(kept).map(underHome);
    throw new AiregError(`Job ${jobName(kept)} uses registry ${alias} to ${does}.`, {
      code: ErrorCode.Conflict,
      hint:
        own.length === 0 && folders.length > 0
          ? `Stop publishing them first with \`${unwatchCommand(folders, scope.scope)}\`.`
          : `Remove it first with \`aireg job remove ${kept.id}\`.`,
    });
  }
  return jobs;
}

/** Through the registry's account, or publishing into it, whatever account it runs as. */
function uses(job: Job, alias: string, accounts: ReadonlySet<string>): boolean {
  return accounts.has(job.account) || job.steps.some((step) => step.to?.split("/")[0] === alias);
}

/** What `add` creates to keep a scope in sync: aireg's own steps, none of them your folders. */
function syncsOnly(job: Job): boolean {
  return job.steps.every((step) => isScopeStep(step) && step.kind !== "origins");
}

export function jobsClause(jobs: readonly Job[]): string {
  if (jobs.length === 0) return "";
  const noun = jobs.length === 1 ? "background job" : "background jobs";
  return ` and its ${noun} ${listOf(jobs.map(jobName))}`;
}

/** Only the jobs already checked and named; one added meanwhile is left alone. */
export async function removeJobs(wanted: readonly string[]): Promise<void> {
  await withDaemon((client) =>
    withFreshConfig(client, async (config) => {
      const ids = wanted.filter((id) => config.jobs.some((job) => job.id === id));
      if (ids.length === 0) return;
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { remove: ids },
      });
    }),
  );
}
