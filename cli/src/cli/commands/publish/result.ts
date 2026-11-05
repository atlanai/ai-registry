import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Changes } from "#engine/publish/changes.ts";
import type { Skipped } from "#engine/publish/exports.ts";

interface PublishedArtifact {
  name: string;
  kind: ArtifactKind;
  /** The registry's name, or for `--to <folder>`, the folder as `--to` gave it. */
  registry: string;
  namespace: string;
  /** `null` when the registry does not hold it yet. */
  from: string | null;
  version: string;
  /** Leaves out the version. */
  digest: string;
  belowLatest: boolean;
  published: boolean;
  dependsOn: { to: string }[];
  /** An agent's files, when it has more than its entry. */
  files?: string[];
  filesChanged?: Changes["files"];
  dependsOnChanged?: Changes["dependsOn"];
}

export interface PublishReport {
  dryRun: boolean;
  /** `null` when each went where it came from. */
  target: { registry: string; namespace: string } | null;
  artifacts: PublishedArtifact[];
  skipped: Skipped[];
}
