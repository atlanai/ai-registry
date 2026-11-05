import type { Outcome } from "#cli/render/plan.ts";

/** `aireg install`: what the run changed, and the artifacts it found already up to date. */
export interface InstallResult extends Outcome {
  unchanged: string[];
}
