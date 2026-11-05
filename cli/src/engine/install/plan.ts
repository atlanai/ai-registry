import { credentialsForManifest } from "#accounts/credentials.ts";
import type { Want } from "#adapter/index.ts";
import { loadAdapter } from "#core/adapter/load.ts";
import { withheldAt, withheldMessage } from "#core/catalog/withheld.ts";
import type { NameCollision } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { dict } from "#core/fields.ts";
import { runPipelineHooks } from "#core/hook/run.ts";
import type { Lock } from "#core/lock.ts";
import { acquire } from "#core/plan/acquire/acquire.ts";
import { answers, lockView } from "#core/plan/acquire/lock-view.ts";
import { build } from "#core/plan/build/build.ts";
import { formatNeed, type Unresolved, wantOf } from "#core/plan/depends.ts";
import type { Acquired, Plan } from "#core/plan/model.ts";
import { recordOf } from "#core/plan/model.ts";
import { wrappedInLock, wrapsNamespaces } from "#core/plan/namespaces.ts";
import { survey } from "#core/plan/survey.ts";
import type { Printer } from "#core/term/printer.ts";
import { VERSION } from "#core/version.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Loaded } from "#engine/scope/load.ts";
import type { RunHooks } from "./pipeline.ts";

/**
 * The lock is the source of truth: a registry it fully answers is planned
 * from it, and its registry is opened only for what the lock cannot supply.
 */
export async function plan(
  loaded: Loaded,
  common: CommonOptions,
  printer: Printer,
  cwd: string,
  hooks: RunHooks,
  targets: readonly string[],
  nameCollision: NameCollision,
): Promise<{ planned: Plan; acquired: Acquired[] }> {
  const { roots, manifest, lock, targetTable } = loaded;
  const aliases = Object.keys(manifest.registries);
  // Carried rows are planned from the lock alone, so their copies are not hashed.
  const opened = hooks.aliases === undefined ? undefined : new Set(hooks.aliases);
  const surveyed =
    opened === undefined
      ? lock
      : {
          ...lock,
          artifacts: dict(
            Object.entries(lock.artifacts).filter(([, row]) => opened.has(row.registry)),
          ),
        };
  const state = await survey(surveyed, roots);

  const moving = hooks.moving ?? new Set<string>();
  // What the manifest's artifacts depend on, asked of their registry once a plan finds it missing.
  const needs = new Map<string, Want[]>();
  const settled = new Map<string, Acquired>();
  const view = lockView(lock);
  for (const alias of hooks.aliases ?? aliases) {
    if (view.rows(alias).some(([name]) => moving.has(name))) continue;
    const source = view.source(alias);
    if (source === undefined || !answers(manifest, source, hooks.held)) continue;
    // Only user scope wraps; an adapter that will not load leaves its rows as the lock has them.
    const namespacePlugins =
      roots.scope === "user" &&
      (await loadAdapter(source.origin.adapter).then(wrapsNamespaces, () =>
        wrappedInLock(view.rows(alias), { roots, targetTable }),
      ));
    settled.set(alias, { ...source, namespacePlugins });
  }
  // Only a registry being opened needs its account, which may refresh a token.
  const open = async (only: readonly string[]) =>
    acquire(manifest, {
      base: roots.base,
      aliases: only,
      onStep: (message) => printer.step(message),
      credentials: await credentialsForManifest(manifest.registries, cwd, undefined, only),
      locked: { lock, moving, held: hooks.held === true },
      needs,
    });
  const acquired = await open((hooks.aliases ?? aliases).filter((alias) => !settled.has(alias)));
  try {
    await runPipelineHooks("prePlan", { targets, aliases });
    const planFrom = (sources: readonly Acquired[]) =>
      build(manifest, lock, sources, state, {
        roots,
        targets,
        targetTable,
        force: common.force,
        copy: common.copy,
        refresh: hooks.refresh === true,
        cliVersion: VERSION,
        nameCollision,
        ...(hooks.aliases === undefined ? {} : { opened: hooks.aliases }),
        ...(hooks.discard === undefined ? {} : { discard: hooks.discard }),
        ...(hooks.adopt === undefined ? {} : { adopt: hooks.adopt }),
      });
    let planned = planFrom([...settled.values(), ...acquired]);
    while (planned.conflicts.length === 0) {
      const needed = new Set(needsRegistry(planned, lock, settled));
      const sources = [...settled.values(), ...acquired];
      for (const missing of planned.unresolved.filter(
        (item) => !keptWithheld(item, sources, lock),
      )) {
        const asked = needs.get(missing.alias) ?? [];
        const want = wantOf(missing.need);
        if (asked.some((item) => JSON.stringify(item) === JSON.stringify(want))) {
          throw unpublished(missing);
        }
        needs.set(missing.alias, [...asked, want]);
        needed.add(missing.alias);
      }
      if (needed.size === 0) break;
      for (const alias of needed) settled.delete(alias);
      // Asked again with more wants, a registry replaces what it listed before.
      const kept = acquired.filter((source) => !needed.has(source.alias));
      await closeAll(acquired.filter((source) => needed.has(source.alias)));
      acquired.splice(0, acquired.length, ...kept);
      acquired.push(...(await open([...needed])));
      planned = planFrom([...settled.values(), ...acquired]);
    }
    await runPipelineHooks("postPlan", { targets, aliases });
    return { planned, acquired };
  } catch (error) {
    await closeAll(acquired);
    throw error;
  }
}

/**
 * Registries planned from the lock alone that the plan needs the registry for
 * after all: their bytes, or a plugin, whose members only the registry lists.
 */
function needsRegistry(plan: Plan, lock: Lock, settled: ReadonlyMap<string, Acquired>): string[] {
  const next = recordOf(plan);
  const needed = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === "record") continue;
    const row = next.artifacts[action.name] ?? lock.artifacts[action.name];
    if (row === undefined || !settled.has(row.registry)) continue;
    if (action.kind === "stage" || row.kind === "plugin") needed.add(row.registry);
  }
  return [...needed].sort();
}

/**
 * A need its registry withholds by status is not asked for again: the lock keeps the copy it holds,
 * and one it does not hold is refused, since nothing installs a blocked version.
 */
function keptWithheld(missing: Unresolved, sources: readonly Acquired[], lock: Lock): boolean {
  const { alias, need, by } = missing;
  const source = sources.find((item) => item.alias === alias);
  const at = { name: need.name, group: need.namespace, kind: need.kind };
  const withheld = withheldAt(source?.catalog.withheld, at);
  if (withheld === undefined) return false;
  const held = Object.values(lock.artifacts).some(
    (row) =>
      row.registry === alias &&
      row.namespace === need.namespace &&
      row.kind === need.kind &&
      row.name === need.name &&
      row.version === need.version,
  );
  if (held) return true;
  throw new AiregError(`${by} needs ${withheldMessage(withheld)}, so nothing was installed.`, {
    code: ErrorCode.Invalid,
    hint: `Ask the registry's owner about it, or remove ${by}.`,
  });
}

function unpublished({ alias, need, by }: Unresolved): AiregError {
  return new AiregError(
    `${by} needs ${formatNeed(need)}, which ${alias} does not publish, so nothing was installed.`,
    { code: ErrorCode.NotFound, hint: `Ask the registry's owner to publish it, or remove ${by}.` },
  );
}

export async function closeAll(sources: readonly Acquired[]): Promise<void> {
  await Promise.allSettled(sources.map((source) => source.close()));
}
