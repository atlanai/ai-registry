import { isRetryable } from "#adapter/errors.ts";
import { isAdapterError } from "#adapter/index.ts";
import { type Withheld, withheldAt, withheldMessage } from "#core/catalog/withheld.ts";
import { digest } from "#core/fs/digest.ts";
import { exists } from "#core/fs/tree.ts";
import { kindSpec } from "#core/kinds.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { fetchFrom, listedAt } from "#core/plan/acquire/sources.ts";
import { describeCarried } from "#core/plan/carries.ts";
import { closure } from "#core/plan/depends.ts";
import type { Acquired, Fetch, Selected } from "#core/plan/model.ts";
import { select, type Untrusted } from "#core/plan/select.ts";
import { type Unlisted, unlistedReason, unlistedRows } from "#core/plan/unlisted.ts";
import { artifactPath, copyLeaf, type Roots } from "#core/store/paths.ts";
import { abbreviate } from "#core/term/printer.ts";
import { classify } from "./classify.ts";
import type { Digests, SyncItem } from "./model.ts";
import { unlockedCopies } from "./unlocked.ts";

/** Read only: every sync starts here, which is why `--dry-run` and a real run agree. */
export async function reconcile(
  manifest: Manifest,
  lock: Lock,
  acquired: readonly Acquired[],
  roots: Pick<Roots, "artifacts">,
): Promise<SyncItem[]> {
  // Dependencies of declared artifacts are tracked too, though the manifest names none.
  const needs = closure(select({ manifest, lock, acquired }).selected, acquired);
  const { selected, untrusted } = select({
    manifest: { ...manifest, artifacts: [...manifest.artifacts, ...needs.refs] },
    lock,
    acquired,
  });
  const content = fetchFrom(acquired);
  const byName = new Map(selected.map((item) => [item.name, item]));
  // Nothing else finds content in the writable copy that neither the lock nor the catalog claims.
  const unlocked = new Map(
    (await unlockedCopies(manifest, lock, roots))
      .filter((copy) => !byName.has(copy.name) && lock.artifacts[copy.name] === undefined)
      .map((copy) => [copy.name, copy]),
  );
  // A kind no loaded adapter declares is never compared: its row stays as it is.
  const declared = Object.entries(lock.artifacts).flatMap(([name, row]) =>
    kindSpec(row.kind) === undefined ? [] : [name],
  );
  const names = new Set([...byName.keys(), ...declared, ...unlocked.keys()]);
  const unlisted = new Map(unlistedRows(manifest, lock, acquired).map((row) => [row.name, row]));

  const items: SyncItem[] = [];
  for (const name of [...names].sort()) {
    const item = byName.get(name);
    const previous = lock.artifacts[name];
    const found = unlocked.get(name);
    const kind = item?.kind ?? previous?.kind ?? found?.kind;
    const source = item?.source ?? previous?.registry ?? found?.registry;
    if (kind === undefined || source === undefined) continue;

    const path = item?.path ?? previous?.path ?? found?.path ?? "";
    // The scope's copy, not the shared mirror, which is never edited and would hide local edits.
    const staged = artifactPath(
      roots,
      source,
      previous?.namespace ?? item?.group ?? found?.namespace,
      kind,
      copyLeaf(name, item?.upstreamName ?? previous?.name ?? name),
      path,
    );

    const watch = watchOf(previous, item);
    const held =
      item === undefined
        ? heldBack(name, previous, acquired, unlisted, untrusted)
        : carriesMoved(item, previous);
    if (held !== undefined) {
      items.push({
        name,
        kind,
        source,
        path,
        disposition: "unavailable",
        digests: { base: undefined, local: undefined, upstream: undefined },
        detail: held,
      });
      continue;
    }

    // One artifact the registry will not serve is reported, rather than ending the run.
    let digests: Digests;
    try {
      digests =
        watch === "yours" && previous !== undefined
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

    const classified = classifyRow(digests, watch, source);
    const detail =
      classified.disposition === "unknown" && digests.base === undefined && previous !== undefined
        ? missingBase(lock, previous)
        : classified.detail;

    items.push({ name, kind, source, path, disposition: classified.disposition, digests, detail });
  }

  return items;
}

/** Import already moved the lock digest to your edit, so a row of yours is never a three-way compare. */
function watchOf(
  previous: LockArtifact | undefined,
  item: Selected | undefined,
): "yours" | "moved" | undefined {
  if (previous?.origin === undefined) return undefined;
  return item !== undefined && item.contentId !== previous.content ? "moved" : "yours";
}

/** A withheld or unlisted row is left for a person to settle; neither is a deletion. */
function heldBack(
  name: string,
  previous: LockArtifact | undefined,
  acquired: readonly Acquired[],
  unlisted: ReadonlyMap<string, Unlisted>,
  untrusted: readonly Untrusted[],
): string | undefined {
  const distrusted = untrusted.find(
    (item) => item.registry === previous?.registry && item.name === previous?.name,
  );
  if (distrusted !== undefined) {
    const { registry, name: plugin, carries } = distrusted;
    return `it now carries ${describeCarried(carries)}, which no entry trusts; run \`aireg add ${registry}/${plugin} --trust ${plugin}\` to take it`;
  }
  const withheld = withheldRow(previous, acquired);
  const gone = unlisted.get(name);
  const why = withheldReason(withheld, gone);
  return why === undefined ? undefined : `${why}; run \`aireg remove ${name}\` to take it out`;
}

function withheldReason(
  withheld: Withheld | undefined,
  gone: Unlisted | undefined,
): string | undefined {
  if (withheld !== undefined) return withheldMessage(withheld);
  return gone === undefined ? undefined : unlistedReason(gone);
}

function withheldRow(
  previous: LockArtifact | undefined,
  acquired: readonly Acquired[],
): Withheld | undefined {
  if (previous === undefined || previous.origin !== undefined) return undefined;
  const source = acquired.find((entry) => entry.alias === previous.registry);
  const at = { name: previous.name, group: previous.namespace, kind: previous.kind };
  return withheldAt(source?.catalog.withheld, at);
}

/** A plugin version that changes what runs as you waits for a person, even when trusted. */
function carriesMoved(item: Selected, previous: LockArtifact | undefined): string | undefined {
  const fingerprint = item.plugin?.fingerprint;
  if (previous === undefined || fingerprint === undefined || fingerprint === previous.carried) {
    return undefined;
  }
  const carries = describeCarried(item.plugin?.carries ?? []);
  return `its new version adds or changes the ${carries} it runs; run \`aireg update ${item.name}\` to take it`;
}

/** No manifest declares a row from your folder, so its published copy is found by address. */
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

/** Only an artifact whose content moved from the lock's pin is fetched. */
async function compare(
  item: Selected | undefined,
  previous: LockArtifact | undefined,
  staged: string,
  content: Fetch,
): Promise<Digests> {
  const base =
    previous?.digest === undefined || previous.digest === "" ? undefined : previous.digest;
  const local = (await exists(staged)) ? await digest(staged, base) : undefined;

  if (item === undefined) return { base, local, upstream: undefined };

  const unmoved =
    item.contentId !== undefined &&
    previous?.content !== undefined &&
    item.contentId === previous.content;
  if (unmoved && base !== undefined) return { base, local, upstream: base };

  return {
    base,
    local,
    upstream: await digest((await content(item.source, item.path)).path, base),
  };
}

function classifyRow(
  digests: Digests,
  watch: ReturnType<typeof watchOf>,
  registry: string,
): ReturnType<typeof classify> {
  if (watch === "yours") return classifyOrigin(digests);
  if (watch === "moved") return classifyMoved(digests, registry);
  return classify(digests);
}

/** Your folder is the source of truth for its rows, so any difference is sent up. */
function classifyOrigin(digests: Digests): ReturnType<typeof classify> {
  if (digests.upstream === undefined)
    return { disposition: "publish", detail: "not published yet" };
  if (digests.local === digests.upstream) return { disposition: "synced", detail: undefined };
  return { disposition: "publish", detail: "changed in your folder" };
}

/** Only a person knows whether your folder is behind or edited too, so `sync resolve` settles it. */
function classifyMoved(digests: Digests, registry: string): ReturnType<typeof classify> {
  if (digests.local !== undefined && digests.local === digests.upstream) {
    return { disposition: "synced", detail: undefined };
  }
  return { disposition: "conflict", detail: `changed in ${registry} since your folder sent it` };
}

function missingBase(lock: Lock, artifact: LockArtifact): string {
  const revision = lock.registries[artifact.registry]?.revision;
  if (revision !== undefined) {
    return `the version in the lockfile (${abbreviate(revision)}) is no longer in the registry, so there is nothing to compare against`;
  }
  return "the lockfile does not record what this was installed as, so there is nothing to compare against";
}
