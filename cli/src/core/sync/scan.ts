import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ifReadable } from "#adapter/files.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { sanitizeName } from "#adapter/text.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { AiregError } from "#core/errors.ts";
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
    // Whoever made a link (a dotfiles checkout, say) owns its target, so only reports follow it.
    if (item.isSymbolicLink() && !followLinks) continue;
    const type = item.isSymbolicLink() ? await linked(full) : item;
    if (type === undefined) continue;
    const entry = await entryOf(root, full, item.name, spec, group, type);
    if (entry !== undefined) entries.push(entry);
  }

  return entries;
}

async function entryOf(
  root: string,
  full: string,
  name: string,
  spec: Omit<KindDir, "dir">,
  group: string | undefined,
  type: Pick<Stats, "isDirectory" | "isFile">,
): Promise<Entry | undefined> {
  if (spec.shape === "directory") {
    return type.isDirectory() ? directoryEntry(root, full, name, spec, group) : undefined;
  }
  return type.isFile() ? fileEntry(root, full, name, spec, group) : undefined;
}

async function linked(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    // Gone, looping or unreadable: no target can load it either.
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
  // Targets keep their own folders beside artifacts; one without the kind's entry file is not one.
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
  return (await ifReadable(stat(path)))?.isFile() ?? false;
}

async function describe(
  file: string,
  fallback: string,
): Promise<{ name: string; description: string | undefined; engine: string | undefined }> {
  const text = await ifReadable(readFile(file, "utf8"));
  if (text === undefined) {
    return { name: sanitizeName(fallback), description: undefined, engine: undefined };
  }
  const meta = frontmatter(text);
  return {
    name: sanitizeName(meta.name ?? fallback),
    description: meta.description === undefined ? undefined : descriptionText(meta.description),
    engine: meta.engine,
  };
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
  const { name, description, engine } = await describeFile(full, stem, extension);
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

function describeFile(
  full: string,
  stem: string,
  extension: string,
): Promise<{ name: string; description: string | undefined; engine: string | undefined }> {
  if (extension === ".json") {
    return Promise.resolve({ name: sanitizeName(stem), description: undefined, engine: undefined });
  }
  if (extension === ".toml") return describeToml(full, stem);
  return describe(full, stem);
}

/** A target's own TOML, such as a Codex agent, keeps name and description at the top level. */
async function describeToml(
  file: string,
  fallback: string,
): Promise<{ name: string; description: string | undefined; engine: undefined }> {
  const keys = tomlKeys(await ifReadable(readFile(file, "utf8")));
  const text = (key: string) => (typeof keys[key] === "string" ? keys[key] : undefined);
  const description = text("description");
  return {
    name: sanitizeName(text("name") ?? fallback),
    description: description === undefined ? undefined : descriptionText(description),
    engine: undefined,
  };
}

/** A file too large or not text still names its artifact, by its file name. */
function tomlKeys(text: string | undefined): NonNullable<ReturnType<typeof readTable>> {
  if (text === undefined) return {};
  try {
    return readTable(text, []) ?? {};
  } catch (error) {
    if (error instanceof AiregError) return {};
    throw error;
  }
}
