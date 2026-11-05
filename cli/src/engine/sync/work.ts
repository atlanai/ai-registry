import { expandSteps, scopeSteps } from "#core/config/jobs.ts";
import { DEFAULT_INTERVAL_SECONDS, isScopeStep, type Job, type Step } from "#core/config/model.ts";
import { type Scope, scopeFor, userScopeDir } from "#core/store/paths.ts";
import type { SyncPolicy } from "#core/sync/policy.ts";
import { policyOf } from "#core/sync/policy.ts";

/**
 * `publish: report` is the invariant, not a default: taking what someone else
 * published is recoverable, sending your half-finished work upstream is not.
 */
export const FOREGROUND_POLICY: SyncPolicy = {
  pull: "on",
  publish: "report",
  delete: "report",
};

/**
 * The executor is handed this rather than the job, so a scheduled run and
 * `aireg sync` take the identical path.
 */
export interface ScopeWork {
  /** The job this came from, or a synthetic id when a command started it. */
  id: string;
  root: string;
  scope: Scope;
  account: string;
  policy: SyncPolicy;
  /** The steps that produced the policy, in declaration order. */
  steps: readonly Step[];
}

/** The scope one job reconciles, derived from the steps that name a root. */
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

/** The runner executes a graph, so a foreground run takes the steps a configured job would have. */
export function jobOfWork(work: ScopeWork): Job {
  return {
    id: work.id,
    account: work.account,
    schedule: { every: DEFAULT_INTERVAL_SECONDS, enabled: false },
    steps: scopeSteps(work.root, work.policy),
  };
}
