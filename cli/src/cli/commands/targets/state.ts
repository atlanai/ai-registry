import { readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Lock } from "#core/lock.ts";
import { exec } from "#core/process.ts";
import { PROJECTIONS_DIR, type Roots } from "#core/store/paths.ts";
import type { Target, Targets, WrappedMapping, WrappedSetup } from "#core/target/contract.ts";
import { mergedPlugin, mergesWrapped, targetRoot } from "#core/target/index.ts";
import { expand, placementPattern } from "#core/target/template.ts";

/** A registry's namespaces, merged into one plugin for a target. */
interface MergedPlugin {
  registry: string;
  folder: string;
  skills: number;
  agents: number;
  /** Whether the target lists it as installed; undefined when it could not be asked. */
  installed: boolean | undefined;
}

/** What one target loads from your user scope. */
export interface TargetState {
  target: string;
  displayName: string;
  /** Artifacts linked into it. */
  artifacts: number;
  plugins: MergedPlugin[];
  /** Namespace links still where the target's own plugins go, from before it merged them. */
  earlier: string[];
  /** Why `installed` is unknown, when it is. */
  unknown?: string;
}

/** `{source}` and `{root}` filled in each of a setup command's words. */
export function setupArgv(command: readonly string[], source: string, root: string): string[] {
  return command.map((word) => expand(word, { source, root, name: source }));
}

/** The registries whose wrapped namespaces the lock links into a target. */
function registriesIn(lock: Lock, target: Target, wrapped: WrappedMapping, roots: Roots): string[] {
  const own = resolve(targetRoot(target, roots.scope, roots.cwd));
  const pattern = placementPattern(wrapped.subdir);
  const found = new Set<string>();
  for (const row of Object.values(lock.artifacts)) {
    for (const link of row.links) {
      if (link.target !== target.name) continue;
      const at = pattern.match(resolve(roots.base, link.path));
      if (at?.vars.source !== undefined && resolve(at.root) === own) {
        found.add(at.vars.source);
      }
    }
  }
  return [...found].sort();
}

async function count(dir: string): Promise<number> {
  return (await readdir(dir).catch(() => [])).length;
}

/** Links in the target's own plugin folder that lead into this scope's projections. */
async function earlierLinks(target: Target, roots: Roots): Promise<string[]> {
  const subdir = target.kinds.plugin?.subdir;
  if (subdir === undefined || subdir.includes("{")) return [];
  const dir = join(targetRoot(target, roots.scope, roots.cwd), subdir);
  const projections = join(roots.artifacts, PROJECTIONS_DIR);
  const out: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const at = join(dir, name);
    const to = await readlink(at).catch(() => undefined);
    if (to !== undefined && resolve(dir, to).startsWith(`${projections}/`)) out.push(at);
  }
  return out.sort();
}

/** The ids the target lists as installed, or why it could not say. */
export async function installedIds(
  setup: WrappedSetup,
  root: string,
): Promise<Set<string> | string> {
  const [program, ...args] = setupArgv(setup.list, "", root);
  if (program === undefined) return "it names no command that lists its plugins";
  const ran = await exec(program, args, { timeoutMs: 30_000 });
  if (ran.code !== 0) return ran.stderr.trim().split("\n").at(-1) ?? `${program} failed`;
  try {
    const items: unknown = JSON.parse(ran.stdout);
    if (!Array.isArray(items)) return `${program} did not print a list`;
    return new Set(items.flatMap((item) => (typeof item?.id === "string" ? [item.id] : [])));
  } catch {
    return `${program} did not print JSON`;
  }
}

async function stateOf(target: Target, lock: Lock, roots: Roots): Promise<TargetState> {
  const artifacts = Object.values(lock.artifacts).filter((row) =>
    row.links.some((link) => link.target === target.name),
  ).length;
  const state: TargetState = {
    target: target.name,
    displayName: target.displayName,
    artifacts,
    plugins: [],
    earlier: [],
  };
  const wrapped = target.kinds.plugin?.wrapped;
  if (wrapped === undefined || !mergesWrapped(target, roots.scope)) return state;
  state.earlier = await earlierLinks(target, roots);
  const root = targetRoot(target, roots.scope, roots.cwd);
  const registries = registriesIn(lock, target, wrapped, roots);
  const ids =
    wrapped.setup === undefined || registries.length === 0
      ? "it names no command that lists its plugins"
      : await installedIds(wrapped.setup, root);
  if (typeof ids === "string" && registries.length > 0) state.unknown = ids;
  for (const registry of registries) {
    const folder = mergedPlugin(target, registry, roots.scope, roots.cwd) as string;
    const id = wrapped.setup === undefined ? "" : setupArgv([wrapped.setup.id], registry, root)[0];
    state.plugins.push({
      registry,
      folder,
      skills: await count(join(folder, "skills")),
      agents: await count(join(folder, "agents")),
      installed: typeof ids === "string" ? undefined : ids.has(id ?? ""),
    });
  }
  return state;
}

/** Each target that has something of your user scope, or that merges namespaces into a plugin. */
export async function agentStates(
  targetTable: Targets,
  lock: Lock,
  roots: Roots,
): Promise<TargetState[]> {
  const out: TargetState[] = [];
  for (const target of Object.values(targetTable)) {
    const state = await stateOf(target, lock, roots);
    if (state.artifacts > 0 || state.plugins.length > 0 || state.earlier.length > 0) {
      out.push(state);
    }
  }
  return out;
}
