import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { sanitizeName } from "#adapter/text.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { descriptionText, frontmatter } from "#core/frontmatter.ts";
import { posixRelative } from "#core/fs/path.ts";
import { isDirectory } from "#core/fs/tree.ts";
import type { KindSpec } from "#core/kinds.ts";
import { readTable } from "#core/target/register/toml.ts";

type KindDir = KindSpec & { kind: ArtifactKind };

/** Scan one kind directory using the same naming rules for sources and targets. */
export async function entriesIn(
  root: string,
  dir: string,
  spec: Omit<KindDir, "dir">,
  group: string | undefined,
  { followLinks = false }: { followLinks?: boolean } = {},
): Promise<Entry[]> {
  if (!(await isDirectory(dir))) return [];

  const items = await readdir(dir, { withFileTypes: true });
  const entries: Entry[] = [];

  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith(".")) continue;
    const full = join(dir, item.name);
    // A link is an entry only to a caller that follows links, such as a report. Whoever made
    // it, a dotfiles checkout for one, owns what it points at, so nothing adopts it.
    const type = item.isSymbolicLink() ? (followLinks ? await linked(full) : undefined) : item;
    if (type === undefined) continue;
    const entry =
      spec.shape === "directory"
        ? type.isDirectory()
          ? await directoryEntry(root, full, item.name, spec, group)
          : undefined
        : type.isFile()
          ? await fileEntry(root, full, item.name, spec, group)
          : undefined;
    if (entry !== undefined) entries.push(entry);
  }

  return entries;
}

/** What a link points at, or undefined when its target is gone. */
async function linked(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function directoryEntry(
  root: string,
  full: string,
  folder: string,
  spec: Omit<KindDir, "dir">,
  group: string | undefined,
): Promise<Entry | undefined> {
  // Targets keep folders of their own beside artifacts; one without the
  // entry file its kind declares is not that kind, and a publish is refused.
  const marker = spec.entry === undefined ? undefined : join(full, spec.entry);
  if (marker !== undefined && !(await isFile(marker))) return undefined;
  const { name, description, engine } =
    marker === undefined
      ? { name: sanitizeName(folder), description: undefined, engine: undefined }
      : await describe(marker, folder);
  return {
    name,
    kind: spec.kind,
    path: posixRelative(root, full),
    group,
    description,
    engine,
    from: { file: posixRelative(root, marker ?? full), pointer: "" },
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function describe(
  file: string,
  fallback: string,
): Promise<{ name: string; description: string | undefined; engine: string | undefined }> {
  try {
    const meta = frontmatter(await readFile(file, "utf8"));
    return {
      name: sanitizeName(meta.name ?? fallback),
      description: meta.description === undefined ? undefined : descriptionText(meta.description),
      engine: meta.engine,
    };
  } catch {
    return { name: sanitizeName(fallback), description: undefined, engine: undefined };
  }
}

async function fileEntry(
  root: string,
  full: string,
  file: string,
  spec: Omit<KindDir, "dir">,
  group: string | undefined,
): Promise<Entry | undefined> {
  const extension = spec.extensions.find((ext) => file.endsWith(ext));
  if (extension === undefined) return undefined;
  const stem = file.slice(0, -extension.length);
  const { name, description, engine } =
    extension === ".json"
      ? { name: sanitizeName(stem), description: undefined, engine: undefined }
      : extension === ".toml"
        ? await describeToml(full, stem)
        : await describe(full, stem);
  return {
    name,
    kind: spec.kind,
    path: posixRelative(root, full),
    group,
    description,
    engine,
    from: { file: posixRelative(root, full), pointer: "" },
  };
}

/** A target's own TOML, such as a Codex agent: its name and description are top-level keys. */
async function describeToml(
  file: string,
  fallback: string,
): Promise<{ name: string; description: string | undefined; engine: undefined }> {
  try {
    const keys = readTable(await readFile(file, "utf8"), []) ?? {};
    const text = (key: string) => (typeof keys[key] === "string" ? keys[key] : undefined);
    const description = text("description");
    return {
      name: sanitizeName(text("name") ?? fallback),
      description: description === undefined ? undefined : descriptionText(description),
      engine: undefined,
    };
  } catch {
    return { name: sanitizeName(fallback), description: undefined, engine: undefined };
  }
}
