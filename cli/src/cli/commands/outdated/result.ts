import type { Watched } from "#cli/render/installed.ts";
import type { Scope } from "#core/store/paths.ts";

export interface OutdatedResult {
  scope: Scope;
  artifacts: OutdatedArtifact[];
}

export interface OutdatedArtifact {
  name: string;
  registry: string;
  pinned?: string;
  /** From a watched folder, so `aireg update` never moves it. */
  watched?: Watched;
  /** Empty for one not installed yet. */
  current: string;
  latest: string;
  moved: boolean;
  /** Why it could not be checked, rather than known to be unchanged. */
  unchecked?: string;
  /** New under a registry or namespace the manifest takes whole. */
  added?: true;
  unpublished?: true;
}
