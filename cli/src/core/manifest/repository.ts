import { readFile } from "node:fs/promises";
import { writeAtomic } from "#core/fs/atomic.ts";
import { isMissing } from "#core/fs/path.ts";
import { assertManagedPath } from "#core/store/managed-paths.ts";
import type { Roots } from "#core/store/paths.ts";
import { canonicalIds } from "#core/target/ids.ts";
import { resolveTargets } from "#core/target/table.ts";
import { editManifest } from "./edit.ts";
import { formatManifest } from "./format.ts";
import { emptyManifest, type Manifest } from "./model.ts";
import { parseManifest } from "./parse.ts";

export async function readManifest(path: string): Promise<Manifest> {
  try {
    return canonicalTargets(parseManifest(await readFile(path, "utf8"), path));
  } catch (cause) {
    if (isMissing(cause)) return emptyManifest();
    throw cause;
  }
}

/** Each target by its canonical id, so a command never writes an alias back. */
function canonicalTargets(manifest: Manifest): Manifest {
  const table = resolveTargets(process.env);
  return {
    ...manifest,
    targets: canonicalIds(table, manifest.targets),
    artifacts: manifest.artifacts.map((ref) =>
      ref.targets === undefined ? ref : { ...ref, targets: canonicalIds(table, ref.targets) },
    ),
  };
}

/**
 * Atomic, because commands read the manifest before taking the scope's lease. Takes the
 * scope's roots so a committed `.registry` link cannot redirect the write.
 */
export async function writeManifest(roots: Roots, manifest: Manifest): Promise<string> {
  const path = roots.manifest;
  await assertManagedPath(path, roots, { env: process.env });
  const before = await readFile(path, "utf8").catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;
    throw cause;
  });
  const text = before === undefined ? formatManifest(manifest) : editManifest(before, manifest);
  // Read back first: a manifest no command could read must never reach the disk.
  parseManifest(text, path);
  await writeAtomic(path, text);
  return text;
}
