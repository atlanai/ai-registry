import { basename, extname, join } from "node:path";
import { type ArtifactKind, KINDS } from "#adapter/index.ts";
import { MCP_SERVER_ENTRY, SKILL_ENTRY } from "#adapter/kinds.ts";
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
  mcp_server: {
    dir: "mcp_servers",
    shape: "directory",
    extensions: [],
    entry: MCP_SERVER_ENTRY,
  },
};

/**
 * Kinds the registry scanner walks; `plugin` is found by its manifest, and an MCP server is
 * written into a target's config, never placed as a folder there.
 */
export const SCANNED_KINDS: readonly ArtifactKind[] = KINDS.filter(
  (kind) => kind !== "plugin" && kind !== "mcp_server",
);

/** Commands named otherwise than their kind, which no other kind or command may take. */
export const KIND_COMMANDS: Readonly<Record<string, string>> = { mcp_server: "mcp" };

/** The command `aireg <command>` a kind runs as. */
export function kindCommand(kind: string): string {
  return Object.hasOwn(KIND_COMMANDS, kind) ? (KIND_COMMANDS[kind] as string) : kind;
}

/** The kind with its article, as a sentence names it. */
export function aKind(kind: string): string {
  return `${/^[aeiou]/.test(kind) || kind === "mcp_server" ? "an" : "a"} ${kind}`;
}

/** The kind a folder of artifacts holds, read from its name, such as `skills`. */
export function kindOfDir(dir: string): ArtifactKind | undefined {
  const leaf = basename(dir);
  for (const [kind, spec] of Object.entries(KIND_SPECS)) {
    if (spec.dir === leaf) return kind as ArtifactKind;
  }
  return undefined;
}

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
