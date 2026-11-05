import type { LayoutId } from "#adapter/layouts/ids.ts";
import type { Outcome } from "#cli/render/plan.ts";

export interface AddResult extends Outcome {
  registry: string;
  /** Full names added to the manifest. */
  artifacts: string[];
  /** For a source that is not a registry. */
  layout?: LayoutId;
  /** Each artifact installed only as a dependency, to the names that need it. */
  dependencies: Record<string, string[]>;
  /** The background job that keeps a user scope install current. */
  jobId?: string;
}
