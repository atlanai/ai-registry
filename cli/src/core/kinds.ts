import { basename, extname, join } from "node:path";
import {
  type ArtifactKind,
  type BuiltinKind,
  isBuiltinKind,
  KINDS,
  SKILL_ENTRY,
} from "#adapter/kinds.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "./errors.ts";
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

const BUILTIN_SPECS: Readonly<Record<BuiltinKind, KindSpec>> = {
  plugin: { dir: "plugins", shape: "directory", extensions: [] },
  skill: { dir: "skills", shape: "directory", extensions: [], entry: SKILL_ENTRY },
  agent: {
    dir: "agents",
    shape: "file",
    extensions: [".md"],
    served: [AGENT_ENTRY, AGENT_CARD_ENTRY],
  },
};

/** Undefined for a kind aireg does not know, which is stored as is but never installed. */
export function kindSpec(kind: ArtifactKind): KindSpec | undefined {
  return isBuiltinKind(kind) ? BUILTIN_SPECS[kind] : undefined;
}

/** Every kind with a spec, built-ins first. */
export function knownKinds(): ArtifactKind[] {
  return [...KINDS];
}

/** Kinds the registry scanner walks; `plugin` is found by its manifest. */
export function scannedKinds(): [ArtifactKind, KindSpec][] {
  return knownKinds().flatMap((kind) => {
    const spec = kindSpec(kind);
    return kind === "plugin" || spec === undefined ? [] : [[kind, spec]];
  });
}

/** For messages: a built-in's plural, and any other kind as `<kind> artifacts`. */
export function kindPlural(kind: ArtifactKind): string {
  return isBuiltinKind(kind) ? BUILTIN_SPECS[kind].dir : `${kind} artifacts`;
}

/** For code past the point where artifacts of unknown kinds were left out. */
function knownSpec(kind: ArtifactKind): KindSpec {
  const spec = kindSpec(kind);
  if (spec !== undefined) return spec;
  throw new AiregError(`aireg does not know the kind ${quoted(kind)}.`, {
    code: ErrorCode.Invalid,
    hint: "Install the adapter that declares it, or remove the artifact.",
  });
}

export function kindDir(kind: ArtifactKind): string {
  return knownSpec(kind).dir;
}

/** Anything stranger than a short alphanumeric suffix is not an extension. */
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

/** A version directory always holds files, so a file-shaped kind is one file inside it. */
export function nativePath(versionDir: string, kind: ArtifactKind, sourcePath: string): string {
  if (knownSpec(kind).shape === "directory") return versionDir;
  return join(versionDir, basename(sourcePath));
}

/** Preserve source extensions because file-shaped kinds may support multiple formats. */
export function stagedLeaf(kind: ArtifactKind, name: string, sourcePath: string): string {
  if (knownSpec(kind).shape === "directory") return name;
  const extension = extname(sourcePath);
  return EXTENSION.test(extension) ? `${name}${extension}` : name;
}
