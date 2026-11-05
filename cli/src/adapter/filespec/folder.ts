import { join, posix, win32 } from "node:path";
import type { Artifact, FileRef, Resolution, Want } from "../contract.ts";
import { messageOf } from "../errors.ts";
import { assertUnredirected, isAbsent, readRegular } from "../files.ts";
import { setRecent } from "../lru.ts";
import { isSafePath } from "../paths.ts";
import { identityOf, type ReadPath, readRegistry, SpecError } from "./documents.ts";
import { besideEnvelope, resolveFromRoot } from "./resolve.ts";

/** Every component from the root down is checked for links. */
export async function registryPath(root: string, path: string, allowRoot = false): Promise<string> {
  if (!(allowRoot && path === "")) refuseUnsafe(path);
  const target = join(root, ...path.split(posix.sep));
  try {
    await assertUnredirected(root, target);
  } catch (cause) {
    throw new SpecError(`${path}: ${messageOf(cause)}`, { path, cause });
  }
  return target;
}

function refuseUnsafe(path: string): void {
  if (!isSafePath(path) || win32.isAbsolute(path)) {
    throw new SpecError(`${path} is not a path inside the registry root.`, { path });
  }
}

/**
 * Reads only a regular file reached without a link from the root.
 * With `verified`, folders checked once in this pass are not walked again.
 */
export function rootReader(root: string, verified?: Set<string>): ReadPath {
  return async (path) => {
    refuseUnsafe(path);
    let read: Awaited<ReturnType<typeof readRegular>>;
    try {
      read = await readRegular(root, path, verified);
    } catch (cause) {
      if (isAbsent(cause)) return undefined;
      throw new SpecError(`${path}: ${messageOf(cause)}`, { path, cause });
    }
    if (read.kind === "missing") return undefined;
    if (read.kind === "refused") throw new SpecError(`${path} ${read.reason}.`, { path });
    return read.bytes;
  };
}

export interface FolderRegistry {
  /** `fetch` and `localRoot` read only what the last resolve listed. */
  resolve(root: string, wanted: readonly Want[], all?: boolean): Promise<Resolution>;
  localRoot(artifact: Artifact): Promise<string | undefined>;
  fetch(artifact: Artifact, file: FileRef): Promise<Uint8Array>;
  /** After a write, nothing resolved before it may be read until the next resolve. */
  forget(): void;
}

// Bounded, since a daemon resolves forever.
const SETTLED = new Map<string, Resolution>();
const SETTLED_LIMIT = 32;

/** For a registry that ends up as a folder on disk. Failures are `SpecError`s. */
export function openFolderRegistry(
  options: {
    /** The content never changes once written, such as a checkout of one commit. */
    immutable?: boolean;
  } = {},
): FolderRegistry {
  let root: string | undefined;
  const listed = new Set<string>();

  const within = (artifact: Artifact): string => {
    if (root === undefined || !listed.has(artifact.id)) {
      throw new SpecError(`${artifact.id} is not in the registry's current listing.`, {
        path: artifact.id,
        missing: true,
        artifact: artifact.id,
      });
    }
    return root;
  };

  return {
    async resolve(at, wanted, all) {
      await registryPath(at, "", true);
      const key = settledKey(at, wanted, all);
      const kept = options.immutable === true ? SETTLED.get(key) : undefined;
      let resolution: Resolution;
      if (kept !== undefined) {
        resolution = structuredClone(kept);
      } else {
        const read = rootReader(at, new Set());
        const registry = await readRegistry(read);
        const found = await resolveFromRoot(read, { blobUrl: registry.blobUrl, wanted, all });
        resolution = { ...found, registry: identityOf(registry) };
        if (options.immutable === true) {
          setRecent(SETTLED, key, structuredClone(resolution), SETTLED_LIMIT);
        }
      }
      root = at;
      listed.clear();
      for (const artifact of resolution.artifacts) listed.add(artifact.id);
      return resolution;
    },

    async localRoot(artifact) {
      if (!besideEnvelope(artifact)) return undefined;
      return registryPath(within(artifact), artifact.id);
    },

    async fetch(artifact, file) {
      const bytes = await rootReader(within(artifact))(file.locator);
      if (bytes === undefined) {
        throw new SpecError(`${file.locator} is missing from the registry.`, {
          path: file.locator,
          missing: true,
          artifact: artifact.id,
        });
      }
      return bytes;
    },

    forget() {
      listed.clear();
    },
  };
}

function settledKey(root: string, wanted: readonly Want[], all: boolean | undefined): string {
  return `${root}\u0000${JSON.stringify(wanted)}\u0000${all === true}`;
}
