import { canonicalize } from "#adapter/spec/canonical.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { readTextIfPresent } from "#core/fs/path.ts";
import { openDocument } from "./register.ts";

/** What a lockfile receipt records of a config entry, so an edit to it is seen. */
export function entryDigest(value: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalize(value));
}

/** The digest of the entry at `at` as it is now; undefined when it is not there. */
export async function currentEntryDigest(
  file: string,
  format: "json" | "toml" | "yaml",
  at: readonly string[],
  items?: readonly string[],
): Promise<string | undefined> {
  const text = await readTextIfPresent(file);
  if (text === undefined) return undefined;
  try {
    const doc = openDocument(format, text, {}, file);
    if (items !== undefined) return itemsDigest(items, doc.list(at) ?? []);
    const table = doc.table(at);
    return table === undefined ? undefined : entryDigest(table);
  } catch {
    // A file that no longer parses holds no entry aireg can recognize as its own.
    return undefined;
  }
}

/** The digest of those of `items` that `list` holds, in their order; undefined when none are. */
export function itemsDigest(
  items: readonly string[],
  list: readonly unknown[],
): string | undefined {
  const present = items.filter((item) => list.includes(item));
  return present.length === 0 ? undefined : entryDigest({ items: present });
}
