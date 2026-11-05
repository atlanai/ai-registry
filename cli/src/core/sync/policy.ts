import {
  type BuiltinStepKind,
  isBuiltinStepKind,
  type Step,
  type StepPolicy,
} from "#core/config/model.ts";
import type { Disposition } from "./model.ts";

/** A step kind that is not in the run leaves its axis off. */
export interface SyncPolicy {
  pull: StepPolicy;
  publish: StepPolicy;
  delete: StepPolicy;
  /** First publishes of local work; absent, they follow `publish`. */
  adopt?: StepPolicy;
  /**
   * Replace a local copy the registry serves at the same bytes with the managed one.
   * Absent means never: a person's folder stays theirs.
   */
  claim?: StepPolicy;
}

/** In the order a person reads them. */
export const POLICY_AXES = [
  "pull",
  "publish",
  "delete",
  "adopt",
  "claim",
] as const satisfies readonly (keyof SyncPolicy)[];
export type PolicyAxis = (typeof POLICY_AXES)[number];

/** Left absent unless a caller names them, so the defaults hold. */
export const OPTIONAL_AXES = ["adopt", "claim"] as const satisfies readonly PolicyAxis[];

export const NOTHING: SyncPolicy = Object.freeze({ pull: "off", publish: "off", delete: "off" });

const OWNS: Readonly<Partial<Record<BuiltinStepKind, PolicyAxis>>> = {
  pull: "pull",
  publish: "publish",
  prune: "delete",
  adopt: "adopt",
  claim: "claim",
};

export function policyOf(steps: readonly Step[]): SyncPolicy {
  const policy: SyncPolicy = { ...NOTHING };
  for (const step of steps) {
    const axis = isBuiltinStepKind(step.kind) ? OWNS[step.kind] : undefined;
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
