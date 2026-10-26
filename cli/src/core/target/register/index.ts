import { rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { redirection } from "#adapter/files.ts";
import { isWithin } from "#adapter/paths.ts";
import { rewriteAtomic } from "#core/fs/atomic.ts";
import { canonical } from "#core/fs/canonical.ts";
import { inspect } from "#core/fs/link.ts";
import { isStrictlyWithin, posixRelative, readTextIfPresent } from "#core/fs/path.ts";
import { pruneEmptyParent } from "#core/fs/tree.ts";
import type { Scope } from "#core/store/paths.ts";
import type { ConfigValue, KindMapping, RegisterEntry, Targets } from "#core/target/contract.ts";
import { targetRoot } from "#core/target/index.ts";
import {
  expand,
  expandValue,
  fixedPrefix,
  type PlacedPath,
  type PlacementPattern,
  placementPattern,
  placementTemplate,
  type Vars,
} from "#core/target/template.ts";
import { type ConfigDocument, jsonDocument, tomlDocument, yamlDocument } from "./document.ts";

/** A path an apply linked or unlinked. A link names its target; a removal does not know it. */
export interface Touched {
  path: string;
  target: string | undefined;
  /** For a removal, the target the lockfile recorded the link for, when it recorded one. */
  recorded?: string | undefined;
}

/** A config entry left as a person set it, rather than overwritten. */
export interface Kept {
  name: string;
  path: string;
  /** Why it was not edited, when not because a person set it. */
  reason?: string;
  /** A target config file left unedited, for an install or a removal alike. */
  config?: true;
}

/** The run registrations are for: its scope, and the folder a project's target roots are in. */
export interface Where {
  scope: Scope;
  cwd: string;
}

interface OpenFile {
  doc: ConfigDocument;
  /** What the file held before, undefined when it did not exist. */
  before: string | undefined;
  /** What it renders as unedited, so a file nothing changed is not written. */
  baseline: string;
  /** What it started as when missing; a document back to this is deleted. */
  init: Record<string, ConfigValue> | undefined;
  /** The highest folder deleting it may prune. */
  stop: string;
}

/** Every config file this run edits, held open so each is read and written once. */
class Files {
  readonly #open = new Map<string, OpenFile>();

  async get(path: string, entry: RegisterEntry, vars: Vars, stop: string): Promise<ConfigDocument> {
    const held = this.#open.get(path);
    if (held !== undefined) return held.doc;
    const before = await readTextIfPresent(path);
    const init = entry.init === undefined ? undefined : expandValue(entry.init, vars);
    const doc =
      entry.format === "toml"
        ? tomlDocument(before ?? "", path)
        : entry.format === "yaml"
          ? yamlDocument(before, init ?? {}, path)
          : jsonDocument(before, init ?? {}, path);
    this.#open.set(path, { doc, before, baseline: doc.render(), init, stop });
    return doc;
  }

  async flush(): Promise<void> {
    for (const [path, file] of this.#open) {
      const after = file.doc.render();
      const empty = file.init !== undefined && isDeepStrictEqual(file.doc.value(), file.init);
      if (empty) {
        if (file.before === undefined) continue;
        await rm(path, { force: true });
        if (isStrictlyWithin(file.stop, dirname(path))) await pruneEmptyParent(path, file.stop);
      } else if (after !== file.baseline) {
        await rewriteAtomic(path, after);
      }
    }
  }
}

/** Placements whose expansion of one entry is the same edit, split by whether they still exist. */
interface Group {
  present: Map<string, Vars>;
  absent: Map<string, Vars>;
}

/**
 * One shared list item, marked as aireg's: there while any placement needs it, and gone with
 * the last. An item a person wrote is theirs, and stays.
 */
function append(
  entry: RegisterEntry & { append: string },
  doc: ConfigDocument,
  group: Group,
): void {
  const vars = first(group);
  const at = entry.at.map((key) => expand(key, vars));
  const value = expand(entry.append, vars);
  if (group.present.size > 0) {
    doc.addMarked(at, value);
    return;
  }
  if (!doc.dropMarked(at, value) || (doc.list(at) ?? []).length > 0) return;
  // A list this emptied goes, with any table it left empty.
  doc.drop(at);
  for (let depth = at.length - 1; depth > 0; depth--) {
    const parent = at.slice(0, depth);
    const table = doc.table(parent);
    if (table === undefined || Object.keys(table).length > 0) break;
    doc.drop(parent);
  }
}

function identity(entry: RegisterEntry, vars: Vars): string {
  const { upsert: _, ...shared } = entry;
  return JSON.stringify(expandValue(shared as unknown as ConfigValue, vars));
}

function first(group: Group): Vars {
  return ([...group.present.values()][0] ?? [...group.absent.values()][0]) as Vars;
}

/** One item per placement in a list, matched on `key`; a person's other items stay. */
function upsert(
  { key, item }: NonNullable<RegisterEntry["upsert"]>,
  doc: ConfigDocument,
  group: Group,
  at: string[],
): void {
  const before = doc.list(at);
  const items = [...(before ?? [])];
  const keyOf = (each: unknown) => (each as Record<string, unknown> | null)?.[key];
  for (const each of group.absent.values()) {
    const gone = expandValue(item, each)[key];
    const index = items.findIndex((found) => keyOf(found) === gone);
    if (index >= 0) items.splice(index, 1);
  }
  const wanted = [...group.present.values()]
    .map((each) => expandValue(item, each))
    .sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  for (const want of wanted) {
    const index = items.findIndex((found) => keyOf(found) === want[key]);
    if (index >= 0) items[index] = want;
    else items.push(want);
  }
  if (before !== undefined || items.length > 0) doc.setList(at, items);
}

/** Brings one entry in line with its placements; true when it is left to a person. */
function edit(entry: RegisterEntry, doc: ConfigDocument, group: Group): boolean {
  if (entry.append !== undefined) {
    append(entry, doc, group);
    return false;
  }
  const vars = first(group);
  const at = entry.at.map((key) => expand(key, vars));
  if (entry.upsert !== undefined) {
    upsert(entry.upsert, doc, group, at);
    return false;
  }

  const value = expandValue(entry.value ?? {}, vars);
  const current = doc.table(at);
  const ours =
    current === undefined ||
    Object.entries(value).every(([name, wanted]) => isDeepStrictEqual(current[name], wanted));
  if (entry.conflict === "keep" && !ours) return true;
  if (group.present.size > 0) {
    doc.set(at, value);
    return false;
  }
  if (current === undefined) return false;
  const foreign = Object.keys(current).filter((name) => !Object.hasOwn(value, name));
  if (entry.remove === "entry" || foreign.length === 0) doc.drop(at);
  else if (entry.off !== undefined) doc.set(at, expandValue(entry.off, vars));
  else doc.unset(at, Object.keys(value));
  return false;
}

async function ours(
  placements: readonly PlacedPath[],
  scopeDir: string,
  copies: ReadonlySet<string>,
): Promise<Map<string, Vars>> {
  const out = new Map<string, Vars>();
  for (const placement of placements) {
    const state = await inspect(placement.path);
    const linked =
      state.isLink && state.target !== undefined && isWithin(scopeDir, resolve(state.target));
    if (linked || (state.exists && !state.isLink && copies.has(placement.path))) {
      out.set(placement.path, { ...placement.vars, root: placement.root });
    }
  }
  return out;
}

/** Touched placements grouped by the config entry they share, split by whether they remain. */
function groupsFor(
  entry: RegisterEntry,
  touched: ReadonlyMap<string, Vars>,
  members: ReadonlyMap<string, Vars>,
): Group[] {
  const groups = new Map<string, Group>();
  for (const [path, vars] of touched) {
    const id = identity(entry, vars);
    const group = groups.get(id) ?? { present: new Map(), absent: new Map() };
    (members.has(path) ? group.present : group.absent).set(path, vars);
    groups.set(id, group);
  }
  for (const [path, vars] of members) groups.get(identity(entry, vars))?.present.set(path, vars);
  return [...groups.values()];
}

/** This target's touched paths that match the placement, keyed by the root they sit under. */
function touchedByRoot(
  touched: readonly Touched[],
  target: string,
  pattern: PlacementPattern,
): Map<string, Map<string, Vars>> {
  const byRoot = new Map<string, Map<string, Vars>>();
  for (const touch of touched) {
    const owner = touch.target ?? touch.recorded;
    if (owner !== undefined && owner !== target) continue;
    const found = pattern.match(touch.path);
    if (found === undefined) continue;
    const paths = byRoot.get(found.root) ?? new Map<string, Vars>();
    paths.set(touch.path, { ...found.vars, root: found.root });
    byRoot.set(found.root, paths);
  }
  return byRoot;
}

/**
 * Applies every target's register entries for the placements an apply touched.
 * Entries run in order, and one left to a person stops the rest for its placements.
 */
async function reconcile(
  entries: readonly RegisterEntry[],
  root: string,
  touched: ReadonlyMap<string, Vars>,
  members: ReadonlyMap<string, Vars>,
  files: Files,
  stop: string,
  at: Anchor,
): Promise<Kept[]> {
  const kept: Kept[] = [];
  const blocked = new Set<string>();
  for (const entry of entries) {
    for (const group of groupsFor(entry, touched, members)) {
      if ([...group.present.keys()].some((path) => blocked.has(path))) continue;
      const vars = first(group);
      const file = join(root, expand(entry.file, vars));
      const reason = outside(file, root, at);
      if (reason !== undefined) {
        kept.push({
          name: vars.name ?? expand(entry.file, vars),
          path: file,
          reason,
          config: true,
        });
        for (const path of group.present.keys()) blocked.add(path);
        continue;
      }
      const doc = await files.get(file, entry, vars, stop);
      if (!edit(entry, doc, group)) continue;
      kept.push({ name: expand(entry.at.at(-1) ?? entry.file, vars), path: file });
      for (const path of group.present.keys()) blocked.add(path);
    }
  }
  return kept;
}

/** The run's own spelling of a target root, and the folder its containment is checked from. */
interface Anchor {
  root: string;
  anchor: string;
}

/**
 * Why a config file under the touched `root` is not edited, if it is not: it must be reached
 * through real folders from the anchor. The file itself may be a link, as a person's dotfiles are.
 */
function outside(file: string, root: string, at: Anchor): string | undefined {
  if (!isWithin(root, file)) return "it is not inside the target folder";
  // Rebuilt on the run's spelling, so a root reached another way is still walked from its anchor.
  const real = canonical(at.anchor);
  const path = join(real, relative(at.anchor, at.root), relative(root, file));
  try {
    const found = redirection(real, path, false);
    if (found === undefined) return undefined;
    const shown = posixRelative(real, found.at) || found.at;
    return found.problem === "symlink" ? `${shown} is a symlink` : `${shown} is not a folder`;
  } catch {
    return "it could not be checked";
  }
}

/** The touched root, however it is spelled, is the target's own for this run. */
function isRoot(found: string, root: string): boolean {
  return resolve(found) === resolve(root) || canonical(found) === canonical(root);
}

async function registerMapping(
  target: string,
  mapping: KindMapping,
  touched: readonly Touched[],
  owned: { scopeDir: string; copies: ReadonlySet<string> },
  files: Files,
  at: Anchor,
): Promise<Kept[]> {
  const template = placementTemplate(mapping);
  const entries = mapping.register ?? [];
  if (template === undefined || entries.length === 0) return [];
  const pattern = placementPattern(template);
  const kept: Kept[] = [];
  for (const [root, paths] of touchedByRoot(touched, target, pattern)) {
    // Only the target's own root for this scope: a path elsewhere that merely ends the
    // way a placement does names no config of this target's.
    if (!isRoot(root, at.root)) continue;
    // Only a kind placed as copies by design: a `--copy` install is not registered.
    const copies = mapping.place === "copy" ? owned.copies : new Set<string>();
    const members = await ours(await pattern.scan(root), owned.scopeDir, copies);
    // A link kept back for a person's own folder is theirs to register.
    for (const touch of touched) {
      if (touch.target !== undefined && !members.has(touch.path)) paths.delete(touch.path);
    }
    if (paths.size === 0) continue;
    // Folders below the kind's fixed prefix are ours to tidy; the target's own are not.
    const stop = join(root, ...fixedPrefix(template));
    kept.push(...(await reconcile(entries, root, paths, members, files, stop, at)));
  }
  return kept;
}

/**
 * Writes a target's config entry while a placement of ours needs it and removes it with the
 * last one. Only a link into `scopeDir`, the scope's `.registry` folder, or one of `copies`, the
 * copies the lockfile records, counts as ours.
 */
export async function applyRegister(
  touched: readonly Touched[],
  targetTable: Targets,
  where: Where,
  scopeDir: string,
  copies: ReadonlySet<string> = new Set(),
): Promise<Kept[]> {
  const files = new Files();
  const kept: Kept[] = [];
  const owned = { scopeDir, copies };
  for (const target of Object.values(targetTable)) {
    const root = targetRoot(target, where.scope, where.cwd);
    // A project's own folders hold its target roots, and a link among them may lead out of
    // it; a person's target root is theirs to keep wherever they like, dotfiles included.
    const anchor = where.scope === "project" ? where.cwd : root;
    for (const mapping of Object.values(target.kinds)) {
      if (mapping === undefined) continue;
      // A kind loaded from another scope's installation is that scope's to register.
      if (mapping.scope !== undefined && mapping.scope !== where.scope) continue;
      const at = { root, anchor };
      kept.push(...(await registerMapping(target.name, mapping, touched, owned, files, at)));
    }
  }
  await files.flush();
  return kept;
}
