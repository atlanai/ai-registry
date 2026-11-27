import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Carried } from "#core/plan/carries.ts";

interface ShownArtifact {
  name: string;
  kind: ArtifactKind;
  version?: string;
  body: string;
  /** What a target that loads it starts on its own, such as hooks. */
  carries: Carried[];
  /** For an MCP server: how it runs, and the environment variables it reads. */
  server?: ShownServer;
}

export interface ShownServer {
  runs: { transport: string; command?: string; url?: string }[];
  reads: string[];
  /** Why a package or remote it lists cannot run. */
  leftOut: string[];
}

interface ShownFile {
  /** The Markdown file read. */
  path: string;
  body: string;
  carries: Carried[];
}

export type ShowResult = ShownArtifact | ShownFile;
