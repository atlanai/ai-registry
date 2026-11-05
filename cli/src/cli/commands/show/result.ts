import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Carried } from "#core/plan/carries.ts";

interface ShownArtifact {
  name: string;
  kind: ArtifactKind;
  version?: string;
  body: string;
  /** What a target that loads it starts on its own, such as hooks. */
  carries: Carried[];
}

interface ShownFile {
  /** The Markdown file read. */
  path: string;
  body: string;
  carries: Carried[];
}

export type ShowResult = ShownArtifact | ShownFile;
