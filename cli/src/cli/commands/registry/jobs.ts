import { list as listOf } from "#adapter/text.ts";
import { isScopeStep, type Job, type RegistryConfig } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { type Roots, roots, scopeFor, userScopeDir } from "#core/store/paths.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import { withDaemon } from "#daemon/service.ts";

const jobName = (job: Job) => job.name ?? job.id;

/** The scope a job reconciles, as the runner reads it: its first rooted step, else your user scope. */
function scopeOf(job: Job): string {
  const root = job.steps.find((step) => isScopeStep(step) && step.root !== undefined)?.root;
  const at = root ?? userScopeDir();
  return canonical(roots(scopeFor(at), at).manifest);
}

/** Through the registry's account, or publishing into it, whatever account it runs as. */
function uses(job: Job, alias: string, accounts: ReadonlySet<string>): boolean {
  return accounts.has(job.account) || job.steps.some((step) => step.to?.split("/")[0] === alias);
}

/** What `add` creates to keep a scope in sync: aireg's own steps, none of them your folders. */
function syncsOnly(job: Job): boolean {
  return job.steps.every((step) => isScopeStep(step) && step.kind !== "origins");
}

/**
 * The jobs in this scope that go with the registry, which cannot outlive it. A job set up for
 * more than syncing, such as one that publishes your folders, is refused rather than removed.
 */
export function registryJobs(config: RegistryConfig, alias: string, scope: Roots): Job[] {
  const accounts = new Set(
    config.accounts.filter((account) => account.registry === alias).map((account) => account.id),
  );
  const here = canonical(scope.manifest);
  const jobs = config.jobs.filter((job) => scopeOf(job) === here && uses(job, alias, accounts));
  const kept = jobs.find((job) => !syncsOnly(job));
  if (kept !== undefined) {
    const own = kept.steps.filter((step) => !isScopeStep(step)).map((step) => step.kind);
    const does = own.length === 0 ? "publish your folders" : `run ${listOf([...new Set(own)])}`;
    throw new AiregError(`Job ${jobName(kept)} uses registry ${alias} to ${does}.`, {
      code: ErrorCode.Conflict,
      hint: `Remove it first with \`aireg job remove ${kept.id}\`.`,
    });
  }
  return jobs;
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
