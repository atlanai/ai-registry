import type { PublishRelationship, Want } from "#adapter/index.ts";
import { BUMPS, type Bump } from "#adapter/semver.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { select } from "#cli/prompt/select.ts";
import type { Export, RegistrySource } from "#core/manifest/model.ts";
import { dependsOnFor } from "#engine/publish/exports.ts";
import { type Planned, type Published, plan, readPublished } from "#engine/publish/target.ts";
import type { Work } from "#engine/publish/work.ts";
import type { Loaded } from "#engine/scope/load.ts";
import type { Sending } from "./review.ts";

/** The edges an export carries into one target, given what this run plans for the others. */
type EdgesFor = (
  work: Work,
  target: { registry: string; namespace: string },
  published: Published,
  planned: (path: string) => Promise<Planned | undefined>,
) => Promise<PublishRelationship[] | undefined>;

/** Planned at a patch first; asked how big only when something already published moved. */
export async function planAll(
  step: Interaction,
  works: readonly Work[],
  where: Map<Work, { registry: string; namespace: string }>,
  open: (alias: string) => Promise<Published>,
  bump: Bump | undefined,
  exact: string | undefined,
  force: boolean,
  edgesFor: EdgesFor | undefined,
): Promise<Sending | undefined> {
  const at = (how: Bump) => {
    const pending = new Map<Work, Promise<Sending[number]>>();
    for (const work of works) {
      const target = where.get(work) as { registry: string; namespace: string };
      const planned = async (path: string) => {
        const other = works.find(
          (each) =>
            each.path === path &&
            where.get(each)?.registry === target.registry &&
            where.get(each)?.namespace === target.namespace,
        );
        return other === undefined ? undefined : (await pending.get(other))?.item;
      };
      const next = async () => {
        const published = await open(target.registry);
        const edges = await edgesFor?.(work, target, published, planned);
        return {
          alias: target.registry,
          item: await plan(work, published, target.namespace, how, exact, force, edges),
        };
      };
      pending.set(work, next());
    }
    return Promise.all(pending.values());
  };
  const planned = await at(bump ?? "patch");
  const moved = needsBumpChoice(planned.map(({ item }) => item));
  if (bump !== undefined || exact !== undefined || !moved || !interactive(step)) return planned;
  const picked = await select<Bump>(
    {
      message: "How big a change is this?",
      style: step.printer.errStyle,
      initial: "patch",
      options: BUMPS.map((value) => ({ value, label: value })),
    },
    step.io,
  );
  return canceled(picked) ? undefined : at(picked);
}

function needsBumpChoice(items: readonly Planned[]): boolean {
  return items.some(
    (item) => item.from !== undefined && !item.same && item.work.exported?.version === undefined,
  );
}

export function edgesOf(
  loaded: Loaded,
  found: ReadonlyMap<string, Export> | undefined,
  known: Record<string, RegistrySource>,
  left: ReadonlySet<string>,
): EdgesFor | undefined {
  if (found === undefined) return undefined;
  return async (work, target, published, planned) =>
    work.exported === undefined
      ? undefined
      : dependsOnFor(work, {
          base: loaded.roots.base,
          left,
          manifest: loaded.manifest,
          lock: loaded.lock,
          known,
          target,
          published,
          planned,
        });
}

export function opener(
  known: Readonly<Record<string, RegistrySource>>,
  cwd: string,
  cloneCommand: (alias: string) => string,
  wants: ReadonlyMap<string, readonly Want[]>,
) {
  const opened = new Map<string, Published>();
  const open = async (alias: string): Promise<Published> => {
    const cached = opened.get(alias);
    if (cached !== undefined) return cached;
    const declared = known[alias] as RegistrySource;
    const read = await readPublished(
      alias,
      declared,
      Object.keys(known),
      cwd,
      wants.get(alias) ?? [],
      cloneCommand(alias),
    );
    opened.set(alias, read);
    return read;
  };
  const close = () => Promise.all([...opened.values()].map((entry) => entry.source.handle.close()));
  return { open, close };
}
