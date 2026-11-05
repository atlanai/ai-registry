import { ID as GIT, parseSource } from "#adapters/git/api.ts";
import { ID as LOCAL } from "#adapters/local/api.ts";
import { ID as WELL_KNOWN } from "#adapters/well-known/api.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { RunResult } from "#engine/install/pipeline.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { GITHUB_SLUG, type Named, type Queued, type SourceType, type UsageEvent } from "./model.ts";
import { queue } from "./queue.ts";

const QUERY_LIMIT = 100;
const NAMES_LIMIT = 50;

type Registry = { location: string; adapter: string | undefined };

/** A registry's type, and its `owner/repo` when it is on github.com and so can be checked. */
export function sourceOf({ adapter, location }: Registry): {
  sourceType: SourceType;
  slug?: string;
} {
  if (adapter === LOCAL) return { sourceType: "local" };
  if (adapter === WELL_KNOWN) return { sourceType: "well-known" };
  if (adapter !== undefined && adapter !== GIT) return { sourceType: "other" };
  let spec: ReturnType<typeof parseSource>;
  try {
    spec = parseSource(location);
  } catch {
    return { sourceType: "other" };
  }
  if (spec.kind === "path") return { sourceType: "local" };
  const slug = spec.host?.toLowerCase() === "github.com" ? spec.slug : undefined;
  if (slug === undefined || !GITHUB_SLUG.test(slug)) return { sourceType: "git" };
  return { sourceType: "github", slug };
}

/** Where artifacts came from; the names are queued only for a repository GitHub can confirm. */
function named(
  registry: Registry,
  items: readonly { name: string; kind: string }[],
): Pick<Queued, "github"> & { fields: Named } {
  const { sourceType, slug } = sourceOf(registry);
  const kinds = [...new Set(items.map((item) => item.kind))].sort().join(",");
  if (slug === undefined) return { fields: { sourceType, kinds } };
  const artifacts = items
    .slice(0, NAMES_LIMIT)
    .map((item) => item.name)
    .join(",");
  return { fields: { sourceType, kinds, source: slug, artifacts }, github: [slug] };
}

const BUILTIN_TARGET_IDS = new Set<string>(BUILTIN_TARGETS.map((target) => target.id));

const userScope = (scope: RunResult["scope"]) => (scope === "user" ? { global: "1" as const } : {});

/**
 * One event per registry the run installed from, or removed from. `trigger` says whether the
 * install chose something new (`add`) or restored a project (`install`).
 */
export function trackRun(
  event: "install" | "remove",
  result: RunResult,
  trigger?: "add" | "install",
): void {
  const { applied, before, scope, targets } = result;
  const lock = event === "install" ? applied?.lock : before;
  if (applied === undefined || lock === undefined) return;
  // A target of your own is named by you, so it is sent only as `custom`.
  const agents = [...new Set(targets.map((id) => (BUILTIN_TARGET_IDS.has(id) ? id : "custom")))];
  // A restore's lockfile already records links from another machine, so it reads what this run linked.
  const installed = trigger === "install" ? applied.installed : applied.added;
  const names = event === "install" ? installed : applied.removed;
  for (const [alias, rows] of byRegistry(lock, names)) {
    const registry = lock.registries[alias];
    if (registry === undefined) continue;
    const { fields, github } = named(registry, rows);
    const agentList = agents.sort().join(",");
    const by = trigger === undefined ? {} : { trigger };
    queue({ event: { event, ...by, agents: agentList, ...userScope(scope), ...fields }, github });
  }
}

export function trackUpdate(result: RunResult): void {
  const { applied, before, scope } = result;
  const after = applied?.lock;
  if (after === undefined) return;
  const updated = Object.entries(after.artifacts).filter(([name, row]) => {
    const was = before.artifacts[name];
    return was !== undefined && (was.version !== row.version || was.content !== row.content);
  });
  const artifactCount = String(Object.keys(after.artifacts).length);
  const updatedCount = String(updated.length);
  queue({ event: { event: "update", artifactCount, updatedCount, ...userScope(scope) } });
}

export function trackPublish(
  registry: Registry,
  works: readonly { name: string; kind: string }[],
): void {
  const { fields, github } = named(registry, works);
  queue({ event: { event: "publish", ...fields }, github });
}

/** The query is kept only when every registry searched is a repository GitHub says is public. */
export function trackSearch(
  query: string,
  resultCount: number,
  kind: string | undefined,
  registries: readonly Registry[],
): void {
  const slugs = registries.flatMap((registry) => sourceOf(registry).slug ?? []);
  const checkable = slugs.length > 0 && slugs.length === registries.length;
  const event: UsageEvent = { event: "search", resultCount: String(resultCount) };
  if (kind !== undefined) event.kind = kind;
  if (checkable) event.query = query.slice(0, QUERY_LIMIT);
  queue({ event, github: checkable ? slugs : undefined });
}

export function trackSync(registryCount: number, changedCount: number, failedCount: number): void {
  queue({
    event: {
      event: "sync",
      registryCount: String(registryCount),
      changedCount: String(changedCount),
      failedCount: String(failedCount),
    },
  });
}

function byRegistry(lock: Lock, names: readonly string[]): Map<string, LockArtifact[]> {
  const grouped = new Map<string, LockArtifact[]>();
  for (const name of names) {
    const row = lock.artifacts[name];
    if (row === undefined) continue;
    grouped.set(row.registry, [...(grouped.get(row.registry) ?? []), row]);
  }
  return grouped;
}
