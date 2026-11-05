import { expandSteps, scopeSteps } from "#core/config/jobs.ts";
import { DEFAULT_INTERVAL_SECONDS, isScopeStep, type Job, type Step } from "#core/config/model.ts";
import { type Scope, scopeFor, userScopeDir } from "#core/store/paths.ts";
import type { SyncPolicy } from "#core/sync/policy.ts";
import { policyOf } from "#core/sync/policy.ts";

/**
 * `publish: report` is an invariant: taking what someone else published is recoverable, sending
 * your half-finished work upstream is not.
 */
export const FOREGROUND_POLICY: SyncPolicy = {
  pull: "on",
  publish: "report",
  delete: "report",
};

/** Handed to the executor instead of the job, so a scheduled run and `aireg sync` match. */
export interface ScopeWork {
  /** Synthetic when a command started the run. */
  id: string;
  root: string;
  scope: Scope;
  account: string;
  policy: SyncPolicy;
  steps: readonly Step[];
}

export function workOf(job: { id: string; account: string; steps: readonly Step[] }): ScopeWork {
  // A composite step settles nothing until expanded.
  const scoped = expandSteps(job.steps).filter(isScopeStep);
  const root = scoped.find((step) => step.root !== undefined)?.root ?? userScopeDir();
  return {
    id: job.id,
    root,
    scope: scopeFor(root),
    account: job.account,
    policy: policyOf(scoped),
    steps: scoped,
  };
}

export function jobOfWork(work: ScopeWork): Job {
  return {
    id: work.id,
    account: work.account,
    schedule: { every: DEFAULT_INTERVAL_SECONDS, enabled: false },
    steps: scopeSteps(work.root, work.policy),
  };
}
