import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, SourceManifest } from "../contract.ts";
import type { Tree } from "./tree.ts";

/** The folder a project keeps its manifest, lockfile and installed copies in. */
export const SCOPE_DIR = ".registry";
/** The project manifest's file name inside `SCOPE_DIR`. */
export const MANIFEST_FILE = "manifest.yml";

const PROJECT_MANIFEST = `${SCOPE_DIR}/${MANIFEST_FILE}`;

/** Far past any manifest a person writes, and small enough to parse without a second thought. */
export const MAX_SOURCE_MANIFEST = 256 * 1024;

const SKIPPED = "so what it exports installs without its dependencies";

/** The manifest's bytes, or why they were left unread. */
async function manifestBytes(tree: Tree): Promise<Uint8Array | string | undefined> {
  const folder = (await tree.list("")).find((item) => item.name === SCOPE_DIR);
  if (folder === undefined) return undefined;
  if (folder.type === "link") return "is reached through a symlink";
  const entry = (await tree.list(SCOPE_DIR)).find((item) => item.name === MANIFEST_FILE);
  if (entry === undefined) return undefined;
  if (entry.type !== "file") return entry.type === "link" ? "is a symlink" : "is not a file";
  // Sized before it is read, and again after, as it may have grown in between.
  const { size } = await lstat(join(tree.root, SCOPE_DIR, MANIFEST_FILE));
  const bytes = size > MAX_SOURCE_MANIFEST ? undefined : await tree.read(PROJECT_MANIFEST);
  if (bytes === undefined || bytes.byteLength > MAX_SOURCE_MANIFEST) {
    return `is larger than ${MAX_SOURCE_MANIFEST / 1024} KB`;
  }
  return bytes;
}

/**
 * The project manifest a source holds, beside where each artifact it found sits, for the client
 * to read what the project exports. Untrusted, so one that cannot be read safely, such as a link
 * or a file too large to be a manifest, is left out with a warning rather than failing the read.
 */
export async function projectManifest(
  tree: Tree,
  artifacts: readonly Artifact[],
  warnings: string[],
): Promise<SourceManifest | undefined> {
  let read: Uint8Array | string | undefined;
  try {
    read = await manifestBytes(tree);
  } catch {
    read = "cannot be read";
  }
  if (read === undefined) return undefined;
  if (typeof read === "string") {
    warnings.push(`Skipped ${PROJECT_MANIFEST}, which ${read}, ${SKIPPED}.`);
    return undefined;
  }
  return {
    text: new TextDecoder().decode(read),
    artifacts: artifacts.map((artifact) => ({
      path: artifact.id,
      id: artifact.id,
      kind: artifact.kind,
      name: artifact.envelope.metadata.name,
      ...(artifact.group === undefined ? {} : { namespace: artifact.group }),
    })),
  };
}
