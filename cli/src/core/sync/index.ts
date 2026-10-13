import { isRetryable } from "#adapter/errors.ts";
import { isAdapterError } from "#adapter/index.ts";
import { digest } from "#core/fs/digest.ts";
import { exists } from "#core/fs/tree.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import { abbreviate } from "#core/output.ts";
import { closure } from "#core/plan/depends.ts";
import type { Acquired, Fetch, Selected } from "#core/plan/model.ts";
import { fetchFrom, listedAt } from "#core/plan/model.ts";
import { select } from "#core/plan/select.ts";
import { artifactPath, copyLeaf, type Roots } from "#core/store/paths.ts";
import { classify } from "./classify.ts";
import type { Digests, SyncItem } from "./model.ts";
import { unlockedCopies } from "./unlocked.ts";

function missingBase(lock: Lock, artifact: LockArtifact): string {
  const revision = lock.registries[artifact.registry]?.revision;
  if (revision !== undefined) {
    return `the version in the lockfile (${abbreviate(revision)}) is no longer in the registry, so there is nothing to compare against`;
  }
  // Adopted content: the lock never recorded the bytes this was installed as,
  // so there is no third side to compare the other two against.
  return "the lockfile does not record what this was installed as, so there is nothing to compare against";
}

/**
 * The three digests a disposition is derived from. When the registry still
 * publishes the content the lock pins, only an artifact that moved is fetched.
 */
async function compare(
  item: Selected | undefined,
  previous: LockArtifact | undefined,
  staged: string,
  content: Fetch,
): Promise<Digests> {
  const base =
    previous?.digest === undefined || previous.digest === "" ? undefined : previous.digest;
  const local = (await exists(staged)) ? await digest(staged) : undefined;

  if (item === undefined) return { base, local, upstream: undefined };

  const unmoved =
    item.contentId !== undefined &&
    previous?.content !== undefined &&
    item.contentId === previous.content;
  if (unmoved && base !== undefined) return { base, local, upstream: base };

  return { base, local, upstream: await digest((await content(item.source, item.path)).path) };
}

/**
 * A row from your own folder is declared by no manifest, so its published copy is
 * found by address in the catalog of the registry it went to.
 */
async function compareOrigin(
  previous: LockArtifact,
  staged: string,
  acquired: readonly Acquired[],
  content: Fetch,
): Promise<Digests> {
  const base = previous.digest === "" ? undefined : previous.digest;
  const local = (await exists(staged)) ? await digest(staged) : undefined;
  const source = acquired.find((entry) => entry.alias === previous.registry);
  const at = source === undefined ? undefined : listedAt(previous, source.catalog.entries);
  // Content for an unlisted path throws a plain error, which reconcile would rethrow.
  if (source === undefined || at === undefined || !source.placements.has(at)) {
    return { base, local, upstream: undefined };
  }
  return { base, local, upstream: await digest((await content(source.alias, at)).path) };
}

/**
 * Your own folder is the source of truth for its rows, so a difference is always sent up;
 * one never published has no upstream to compare with, which differs from one that vanished.
 */
function classifyOrigin(digests: Digests): ReturnType<typeof classify> {
  if (digests.upstream === undefined)
    return { disposition: "publish", detail: "not published yet" };
  if (digests.local === digests.upstream) return { disposition: "synced", detail: undefined };
  return { disposition: "publish", detail: "changed in your folder" };
}

/**
 * Read, never acted on. Every sync starts here and then decides what it is
 * willing to do, which is why `--dry-run` and a real run agree.
 */
export async function reconcile(
  manifest: Manifest,
  lock: Lock,
  acquired: readonly Acquired[],
  roots: Pick<Roots, "artifacts">,
): Promise<SyncItem[]> {
  // What the manifest's artifacts depend on is theirs too, though it names none of it.
  const needs = closure(select(manifest, lock, acquired, []), acquired);
  const selected = select(
    { ...manifest, artifacts: [...manifest.artifacts, ...needs.refs] },
    lock,
    acquired,
    [],
  );
  const content = fetchFrom(acquired);
  const byName = new Map(selected.map((item) => [item.name, item]));
  // Content in the writable copy that neither the lock nor the catalog claims
  // is discovered by nothing else.
  const unlocked = new Map(
    (await unlockedCopies(manifest, lock, roots))
      .filter((copy) => !byName.has(copy.name) && lock.artifacts[copy.name] === undefined)
      .map((copy) => [copy.name, copy]),
  );
  const names = new Set([...byName.keys(), ...Object.keys(lock.artifacts), ...unlocked.keys()]);

  const items: SyncItem[] = [];
  for (const name of [...names].sort()) {
    const item = byName.get(name);
    const previous = lock.artifacts[name];
    const found = unlocked.get(name);
    const kind = item?.kind ?? previous?.kind ?? found?.kind;
    const source = item?.source ?? previous?.registry ?? found?.registry;
    if (kind === undefined || source === undefined) continue;

    const path = item?.path ?? previous?.path ?? found?.path ?? "";
    // This scope's own copy, not the shared mirror: the mirror is never edited,
    // so reading it would report every local edit as synced.
    const staged = artifactPath(
      roots,
      source,
      previous?.namespace ?? item?.group ?? found?.namespace,
      kind,
      copyLeaf(name, item?.upstreamName ?? previous?.name ?? name),
      path,
    );

    // A selected row of yours whose registry copy has not moved is still yours: its lock digest
    // is already the edit, so a three-way compare would read the edit as the base.
    const yours =
      previous?.origin !== undefined &&
      (item === undefined || (item.contentId !== undefined && item.contentId === previous.content));

    // One artifact the registry will not serve is reported as that one
    // artifact, rather than ending the run without naming any.
    let digests: Digests;
    try {
      digests = yours
        ? await compareOrigin(previous, staged, acquired, content)
        : await compare(item, previous, staged, content);
    } catch (error) {
      if (!isAdapterError(error)) throw error;
      items.push({
        name,
        kind,
        source,
        path,
        disposition: "unavailable",
        digests: { base: undefined, local: undefined, upstream: undefined },
        detail: error.message,
        failure: { code: `adapter_${error.failure}`, retryable: isRetryable(error) },
      });
      continue;
    }

    const classified = yours ? classifyOrigin(digests) : classify(digests);
    const detail =
      classified.disposition === "unknown" && digests.base === undefined && previous !== undefined
        ? missingBase(lock, previous)
        : classified.detail;

    items.push({ name, kind, source, path, disposition: classified.disposition, digests, detail });
  }

  return items;
}
