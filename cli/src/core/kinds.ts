import { basename, extname, join } from "node:path";
import { type ArtifactKind, KINDS } from "#adapter/index.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { AGENT_CARD_ENTRY } from "./product.ts";

export interface KindSpec {
  /** Plural; used in this scope's own copies and in every target. */
  dir: string;
  shape: "directory" | "file";
  /** Empty for directory-shaped kinds. */
  extensions: readonly string[];
  /**
   * The file that makes a directory this kind and holds its front matter. A directory without
   * it is not this kind; absent, any directory is.
   */
  entry?: string;
  /** Entry filenames a file-shaped kind can install; companion files stay in the registry. */
  served?: readonly string[];
}

/** The one file a registry's agent version folder holds. */
export const AGENT_ENTRY = "AGENT.md";

export const KIND_SPECS: Record<ArtifactKind, KindSpec> = {
  plugin: { dir: "plugins", shape: "directory", extensions: [] },
  skill: { dir: "skills", shape: "directory", extensions: [], entry: SKILL_ENTRY },
  agent: {
    dir: "agents",
    shape: "file",
    extensions: [".md"],
    served: [AGENT_ENTRY, AGENT_CARD_ENTRY],
  },
};

/** Kinds the registry scanner walks; `plugin` is found by its manifest. */
export const SCANNED_KINDS: readonly ArtifactKind[] = KINDS.filter((kind) => kind !== "plugin");

export function kindDir(kind: ArtifactKind): string {
  return KIND_SPECS[kind].dir;
}

/** Anything stranger than a short alphanumeric suffix is not an extension. */
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

/** A version directory always holds files, so a file-shaped kind is one file inside it. */
export function nativePath(versionDir: string, kind: ArtifactKind, sourcePath: string): string {
  if (KIND_SPECS[kind].shape === "directory") return versionDir;
  return join(versionDir, basename(sourcePath));
}

/** Preserve source extensions because file-shaped kinds may support multiple formats. */
export function stagedLeaf(kind: ArtifactKind, name: string, sourcePath: string): string {
  if (KIND_SPECS[kind].shape === "directory") return name;
  const extension = extname(sourcePath);
  return EXTENSION.test(extension) ? `${name}${extension}` : name;
}
