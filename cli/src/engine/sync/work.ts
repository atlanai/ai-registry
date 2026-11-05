import {
  DEFAULT_INTERVAL_SECONDS,
  isScopeStep,
  type Job,
  type Step,
  type StepPolicy,
} from "#core/config/model.ts";
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
  const scoped = job.steps.filter(isScopeStep);
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
  const leaf = (name: string, kind: string, needs: string[], policy: StepPolicy): Step => ({
    name,
    kind,
    needs,
    root: work.root,
    select: [],
    policy,
    extra: {},
  });
  // Adopt and claim only when asked for: an absent axis is what keeps the defaults.
  return {
    id: work.id,
    account: work.account,
    schedule: { every: DEFAULT_INTERVAL_SECONDS, enabled: false },
    steps: [
      leaf("pull", "pull", [], work.policy.pull),
      leaf("publish", "publish", ["pull"], work.policy.publish),
      leaf("prune", "prune", ["pull"], work.policy.delete),
      ...(work.policy.adopt === undefined
        ? []
        : [leaf("adopt", "adopt", ["pull"], work.policy.adopt)]),
      ...(work.policy.claim === undefined
        ? []
        : [leaf("claim", "claim", ["pull"], work.policy.claim)]),
    ],
  };
}
