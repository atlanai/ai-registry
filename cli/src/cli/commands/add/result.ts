import type { LayoutId } from "#adapter/layouts/ids.ts";
import type { Outcome } from "#cli/render/plan.ts";
import type { Carried } from "#core/plan/carries.ts";

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
  /** Plugins left out until trusted with `--trust`, with what each runs as you. */
  untrusted?: { name: string; carries: Carried[] }[];
}
