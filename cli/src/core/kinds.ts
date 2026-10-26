import { basename, extname, join } from "node:path";
import { type ArtifactKind, KINDS } from "#adapter/index.ts";

export { type ArtifactKind, isKind, KINDS } from "#adapter/index.ts";

/** How a kind appears in a registry, and what it is called there. */
export interface KindSpec {
  /** Directory name, both in a registry and in this scope's own copies. */
  dir: string;
  /** A skill is a directory with a SKILL.md; an agent is a single file. */
  shape: "directory" | "file";
  /** Extensions a file-shaped kind may use. Empty for directory-shaped kinds. */
  extensions: readonly string[];
  /**
   * The file that makes a directory one of these, and holds its front matter.
   * A directory without it is not this kind; absent, any directory is.
   */
  entry?: string;
  /** Entry filenames a file-shaped kind can install; companion files stay in the registry. */
  served?: readonly string[];
}

/** The file that makes a directory a skill and holds its front matter. */
export const SKILL_ENTRY = "SKILL.md";

/** The one file a registry's agent version folder holds. */
export const AGENT_ENTRY = "AGENT.md";

import { AGENT_CARD_ENTRY } from "./product.ts";

export { AGENT_CARD_ENTRY };

/** Shared directory and shape vocabulary for discovery and staging. */
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

/** Target-shaped and plural: what the writable copy and every target use. */
export function kindDir(kind: ArtifactKind): string {
  return KIND_SPECS[kind].dir;
}

/**
 * Spec-shaped and singular: what a file spec root addresses a kind by, so a
 * mirror is readable by anything that speaks the spec.
 */
export function specKindDir(kind: ArtifactKind): string {
  return kind;
}

/** Anything stranger than a short alphanumeric suffix is not an extension. */
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

/**
 * A version directory always holds files, so a file-shaped kind is one file
 * inside it rather than the directory itself.
 */
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
