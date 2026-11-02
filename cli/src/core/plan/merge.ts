import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertUnredirected } from "#adapter/files.ts";
import { sanitizeName } from "#adapter/text.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { readTextIfPresent } from "#core/fs/path.ts";
import { pruneEmptyParent } from "#core/fs/tree.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Target, Targets } from "#core/target/index.ts";
import { mergedPlugin, mergesWrapped, resolveTargets, targetRoot } from "#core/target/index.ts";
import { expandValue, fixedPrefix, placementPattern } from "#core/target/template.ts";
import { pointAt } from "./assemble.ts";
import type { Action } from "./model.ts";

/** The folders of a namespace's plugin whose entries load as well from another plugin. */
const PARTS = ["skills", "agents", "commands"] as const;

/** What every merged plugin's manifest says, before any keys of the target's own. */
const DOCUMENT = { name: "{name}", description: "{description}" };

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

async function isFolder(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

/** Each part's entries by the name they take in the merged plugin, and where each comes from. */
async function wanted(namespaces: string): Promise<Map<string, Map<string, string>>> {
  const held = new Map<string, Map<string, string[]>>();
  for (const namespace of await names(namespaces)) {
    if (!(await isFolder(join(namespaces, namespace)))) continue;
    for (const part of PARTS) {
      const dir = join(namespaces, namespace, part);
      const byLeaf = held.get(part) ?? new Map<string, string[]>();
      held.set(part, byLeaf);
      for (const leaf of await names(dir)) {
        byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), namespace]);
      }
    }
  }
  const out = new Map<string, Map<string, string>>();
  for (const [part, byLeaf] of held) {
    const entries = new Map<string, string>();
    for (const [leaf, owners] of byLeaf) {
      // Two namespaces holding one name both take their own as a prefix, so neither depends on order.
      for (const owner of owners) {
        const as = owners.length > 1 ? sanitizedLeaf(owner, leaf) : leaf;
        entries.set(as, join(namespaces, owner, part, leaf));
      }
    }
    if (entries.size > 0) out.set(part, entries);
  }
  return out;
}

/** `<namespace>-<leaf>`, keeping a file's extension. */
function sanitizedLeaf(namespace: string, leaf: string): string {
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const extension = dot > 0 ? leaf.slice(dot) : "";
  return `${sanitizeName(`${namespace}-${stem}`)}${extension}`;
}

async function writeManifests(root: string, target: Target, name: string, description: string) {
  for (const manifest of target.kinds.plugin?.manifest ?? []) {
    const file = join(root, manifest.path);
    await assertUnredirected(root, file);
    const body = manifest.body ?? {};
    const schema = body.$schema === undefined ? {} : { $schema: body.$schema };
    const value = expandValue({ ...schema, ...DOCUMENT, ...body }, { name, description });
    const text = await readTextIfPresent(file);
    let current: unknown;
    try {
      current = text === undefined ? undefined : JSON.parse(text);
    } catch {
      current = undefined;
    }
    if (!isDeepStrictEqual(current, value)) {
      await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
    }
  }
}

/** Removes what a merged plugin holds, and every folder that leaves empty up to `stop`. */
async function clear(root: string, target: Target, stop: string): Promise<void> {
  for (const part of PARTS) await rm(join(root, part), { recursive: true, force: true });
  for (const manifest of target.kinds.plugin?.manifest ?? []) {
    const file = join(root, manifest.path);
    await rm(file, { force: true });
    await pruneEmptyParent(file, root);
  }
  await pruneEmptyParent(join(root, PARTS[0]), stop);
}

/**
 * Builds the one plugin a target loads a registry's wrapped namespaces from: each namespace linked
 * in `namespaces` lends its skills, agents and commands, under their own names, or as
 * `<namespace>-<name>` where two namespaces hold one. Nothing else in `root` is kept.
 */
export async function mergeNamespaces(
  root: string,
  namespaces: string,
  target: Target,
  source: string,
  stop: string,
): Promise<void> {
  const parts = await wanted(namespaces);
  if (parts.size === 0) {
    await clear(root, target, stop);
    return;
  }
  for (const part of PARTS) {
    const dir = join(root, part);
    const entries = parts.get(part) ?? new Map<string, string>();
    for (const leaf of await names(dir)) {
      if (!entries.has(leaf)) await rm(join(dir, leaf), { recursive: true, force: true });
    }
    // Kept when empty: a target serving the folder in place may link only the folders it saw first.
    await mkdir(dir, { recursive: true });
    await assertUnredirected(root, dir);
    for (const [leaf, from] of entries) await pointAt(join(dir, leaf), from);
  }
  const name = sanitizeName(source);
  await writeManifests(root, target, name, `Artifacts the ${name} registry publishes.`);
}

/** The merged folders an apply touched: the target, its root, and each registry's alias. */
function touchedMerges(
  actions: readonly Action[],
  roots: Pick<Roots, "scope" | "cwd">,
  targetTable: Targets,
): Map<string, { target: Target; source: string; namespaces: string; stop: string }> {
  const out = new Map<
    string,
    { target: Target; source: string; namespaces: string; stop: string }
  >();
  const paths = actions.flatMap((action) =>
    action.kind === "link" || action.kind === "unlink" ? [action.to] : [],
  );
  for (const target of Object.values(targetTable)) {
    const wrapped = target.kinds.plugin?.wrapped;
    if (wrapped === undefined || !mergesWrapped(target, roots.scope)) continue;
    const own = targetRoot(target, roots.scope, roots.cwd);
    const pattern = placementPattern(wrapped.subdir);
    for (const path of paths) {
      const found = pattern.match(path);
      const source = found?.vars.source;
      if (found === undefined || source === undefined) continue;
      if (resolve(found.root) !== resolve(own)) continue;
      const root = mergedPlugin(target, source, roots.scope, roots.cwd);
      if (root === undefined) continue;
      out.set(root, {
        target,
        source,
        namespaces: dirname(path),
        stop: join(own, ...fixedPrefix(wrapped.merge)),
      });
    }
  }
  return out;
}

/** Rebuilds every merged plugin whose namespaces this apply linked or unlinked. */
export async function applyMerges(
  actions: readonly Action[],
  roots: Pick<Roots, "scope" | "cwd">,
): Promise<void> {
  for (const [root, { target, source, namespaces, stop }] of touchedMerges(
    actions,
    roots,
    resolveTargets(),
  )) {
    await mergeNamespaces(root, namespaces, target, source, stop);
  }
}
