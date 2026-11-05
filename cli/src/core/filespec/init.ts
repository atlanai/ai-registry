import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJson, SpecError } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { specJson } from "#adapter/filespec/merge.ts";
import { INDEX_DOCUMENT, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { SUPPORTED_FORMAT } from "#adapter/spec/types.ts";
import { sanitizeName } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeAtomic } from "#core/fs/atomic.ts";

/** The registry holding this folder, found by walking up to its `registry.json`. */
export function findRegistry(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, REGISTRY_DOCUMENT))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function requireRegistry(from: string): string {
  const root = findRegistry(from);
  if (root !== undefined) return root;
  throw new AiregError("Not inside a registry.", {
    code: ErrorCode.Usage,
    hint: "Run it in a folder that holds registry.json, or create one with `aireg registry init`.",
  });
}

/**
 * An empty registry: the two documents a reader opens first, and nothing to list.
 * Refused over an existing one, whose catalog this would erase.
 */
export async function writeRoot(
  root: string,
  identity: { name: string; description?: string | undefined },
  at: string,
): Promise<string[]> {
  if ((await readJson(rootReader(root), REGISTRY_DOCUMENT)) !== undefined) {
    throw new SpecError(`${root} is already a registry.`, { path: REGISTRY_DOCUMENT });
  }
  const registry = {
    kind: "registry",
    format_version: SUPPORTED_FORMAT,
    name: identity.name,
    slug: sanitizeName(identity.name),
    ...(identity.description === undefined ? {} : { description: identity.description }),
    capabilities: ["files"],
    auth: { type: "none" },
  };
  await writeAtomic(join(root, REGISTRY_DOCUMENT), specJson(registry));
  await writeAtomic(
    join(root, INDEX_DOCUMENT),
    specJson({ format_version: SUPPORTED_FORMAT, generated_at: at, entries: [] }),
  );
  return [REGISTRY_DOCUMENT, INDEX_DOCUMENT];
}
