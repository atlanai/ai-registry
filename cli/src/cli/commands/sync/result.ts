import type { ArtifactKind } from "#adapter/kinds.ts";
import type { ItemOutcome, RunCounts, RunRecord, RunState } from "#core/run/model.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Disposition } from "#core/sync/model.ts";
import type { SyncOperation } from "#core/sync/policy.ts";

interface PreviewItem {
  name: string;
  kind: ArtifactKind;
  /** Registry address, POSIX separators. */
  path: string;
  disposition: Disposition;
  /** A side with no bytes, such as a registry that never published it, has no digest. */
  digests: { base?: string; local?: string; upstream?: string };
  detail?: string;
  failure?: { code: string; retryable: boolean };
  registry: string;
}

/** A skill or agent in a target folder that the scope does not install. */
interface Found {
  name: string;
  kind: ArtifactKind;
  /** Relative to the scope. */
  path: string;
  target: string;
}

interface Written extends Found {
  /** Where it would sit in a registry laid out the standard way. */
  suggestedPath: string;
}

/** `aireg sync --dry-run`. */
export interface SyncPreview {
  dryRun: true;
  scope: Scope;
  artifacts: PreviewItem[];
  local: Written[];
  undeclared: Found[];
  linkable: Found[];
  changed: Found[];
  kept: Found[];
}

export interface SettledArtifact {
  name: string;
  kind?: ArtifactKind;
  outcome: ItemOutcome;
  operation?: SyncOperation;
  disposition?: Disposition;
}

interface SyncedRegistry {
  registry: string;
  id: string;
  state: RunState;
  counts: RunCounts;
  artifacts: SettledArtifact[];
  /** What the run did to your own files, or left undone. */
  warnings: string[];
}

/** `aireg sync`: a run per registry. */
export interface SyncRuns {
  dryRun: false;
  scope: Scope;
  runs: SyncedRegistry[];
}

/** `aireg sync resolve`. */
export interface SyncResolved {
  run: RunRecord;
  artifacts: SettledArtifact[];
}
