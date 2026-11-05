import type { BuiltinStepKind, Step, StepPolicy } from "#core/config/model.ts";
import type { Disposition } from "./model.ts";

/**
 * What one run is allowed to do, derived from the steps it is about to run. A
 * step kind that is not in the run leaves its axis off.
 */
export interface SyncPolicy {
  pull: StepPolicy;
  publish: StepPolicy;
  delete: StepPolicy;
  /** First publishes of local work. Absent, they follow `publish`. */
  adopt?: StepPolicy;
  /**
   * Replacing a local copy the registry already serves at the same bytes
   * with the managed one. Absent means never: a person's folder stays theirs.
   */
  claim?: StepPolicy;
}

/** Every axis a policy has, in the order a person reads them. */
export const POLICY_AXES = [
  "pull",
  "publish",
  "delete",
  "adopt",
  "claim",
] as const satisfies readonly (keyof SyncPolicy)[];
export type PolicyAxis = (typeof POLICY_AXES)[number];

/** Axes a policy leaves absent unless a caller names them, so the defaults hold. */
export const OPTIONAL_AXES = ["adopt", "claim"] as const satisfies readonly PolicyAxis[];

export const NOTHING: SyncPolicy = Object.freeze({ pull: "off", publish: "off", delete: "off" });

/** The policy axis each step kind sets. */
const OWNS: Readonly<Partial<Record<string, PolicyAxis>>> = Object.freeze({
  pull: "pull",
  publish: "publish",
  prune: "delete",
  adopt: "adopt",
  claim: "claim",
} satisfies Partial<Record<BuiltinStepKind, PolicyAxis>>);

export function policyOf(steps: readonly Step[]): SyncPolicy {
  const policy: SyncPolicy = { ...NOTHING };
  for (const step of steps) {
    const axis = OWNS[step.kind];
    if (axis !== undefined) policy[axis] = step.policy;
  }
  return policy;
}

export const SYNC_OPERATIONS = [
  "none",
  "pull",
  "remove-local",
  "publish",
  "archive",
  "forget",
  "attention",
  "report",
  "ignore",
] as const;

export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

/** Operations that changed something on disk or upstream. */
export const CHANGING_OPERATIONS: readonly SyncOperation[] = [
  "pull",
  "remove-local",
  "publish",
  "archive",
  "forget",
];

export function operation(disposition: Disposition, policy: SyncPolicy): SyncOperation {
  switch (disposition) {
    case "synced":
      return "none";
    case "pull":
      return selected(policy.pull, "pull");
    case "pull-delete":
      return selected(policy.pull, "remove-local");
    case "publish":
      return selected(policy.publish, "publish");
    case "adopt":
      return selected(policy.adopt ?? policy.publish, "publish");
    case "archive":
      return selected(policy.delete, "archive");
    case "removed":
      return "forget";
    case "conflict":
    case "unknown":
    // A person has to look: retrying on a schedule would hide a withdrawn artifact
    // behind an error that never changes.
    case "unavailable":
      return "attention";
  }
}

function selected(value: StepPolicy, change: SyncOperation) {
  if (value === "on") return change;
  return value === "report" ? "report" : "ignore";
}
