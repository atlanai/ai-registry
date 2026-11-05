import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CONCURRENCY, limiter } from "#adapter/concurrency.ts";
import { ifReadable } from "#adapter/files.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import { sanitizeName } from "#adapter/text.ts";
import type { Selector, Step } from "#core/config/model.ts";
import { authoredDigest } from "#core/fs/digest.ts";
import { posixRelative } from "#core/fs/path.ts";
import { canonical, canonicalAsync } from "#core/fs/realpath.ts";
import { authoredArtifact, copyAuthored, exists, type Irregular, refusal } from "#core/fs/tree.ts";
import { KIND_SPECS } from "#core/kinds.ts";
import { type Lock, type LockArtifact, readLock, writeLock } from "#core/lock.ts";
import { listedAt } from "#core/plan/acquire/sources.ts";
import { removeContained } from "#core/plan/removable.ts";
import { assertManagedPath } from "#core/store/managed-paths.ts";
import { artifactPath, type Roots } from "#core/store/paths.ts";
import { canonicalId } from "#core/target/ids.ts";
import { resolveTargets } from "#core/target/table.ts";
import { moveAside } from "./claim.ts";
import type { Scan } from "./scan.ts";

/**
 * A folder step never moves, links over or deletes what it found: the copy under `artifacts/`
 * is what a publish sends, and `origin` says the row is yours.
 */
interface Origin {
  name: string;
  kind: ArtifactKind;
  namespace: string;
  registry: string;
  from: string;
  target: string;
  step: string;
}

export interface OriginOutcome {
  origin: Origin;
  /** `refused`: it holds what a publish refuses, such as a symlink, never followed into the copy. */
  state: "unchanged" | "refreshed" | "missing" | "refused";
  digest: string | undefined;
  reason?: string;
}

export function originKey(origin: Origin): string {
  return `${origin.namespace}/${origin.name}`;
}

export async function surveyOrigins(
  steps: readonly Step[],
  lock: Lock,
  roots: Roots,
): Promise<OriginOutcome[]> {
  const outcomes: OriginOutcome[] = [];
  const seen = new Set<string>();
  const ours = canonical(roots.artifacts);
  // A copy-mode install is a real folder where a link would be, so it reads as
  // authored work unless every path the lock placed is ruled out too.
  const resolving = limiter(CONCURRENCY);
  const placed = new Set(
    await Promise.all(
      Object.values(lock.artifacts).flatMap((row) =>
        row.links.map((link) => resolving(() => canonicalAsync(resolve(roots.base, link.path)))),
      ),
    ),
  );
  const underPlaced = (where: string): boolean => {
    for (let at = where; ; at = dirname(at)) {
      if (placed.has(at)) return true;
      if (dirname(at) === at) return false;
    }
  };

  for (const step of steps) {
    if (step.kind !== "origins") continue;
    for (const selector of step.select) {
      for (const origin of await found(step, selector)) {
        // A folder step offers your work upstream, never what this scope placed.
        const where = canonical(origin.from);
        if (isWithin(ours, where) || underPlaced(where)) continue;
        // One origin may serve two namespaces, but not one namespace twice.
        if (seen.has(originKey(origin))) continue;
        seen.add(originKey(origin));
        outcomes.push(await settle(origin, lock));
      }
    }
  }
  return outcomes;
}

async function found(step: Step, selector: Selector): Promise<Origin[]> {
  const { registry, namespace } = destination(step);
  const kind = kindOfDir(selector.from);
  if (kind === undefined) return [];
  if (selector.kinds !== undefined && !selector.kinds.includes(kind)) return [];

  const entries = (await ifReadable(readdir(selector.from))) ?? [];

  const shape = KIND_SPECS[kind].shape;
  // A selector's id, or a folder's name such as `claude` from `.claude`, may be an alias.
  const target = canonicalId(
    resolveTargets(process.env),
    selector.target?.[0] ?? targetOf(selector.from),
  );
  const origins: Origin[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    // A file kind's extension is not part of the name.
    const name = shape === "file" ? entry.replace(/\.[^.]+$/, "") : entry;
    if (sanitizeName(name) !== name) continue;
    if (!matches(selector.match, name)) continue;
    origins.push({
      name,
      kind,
      namespace,
      registry,
      from: join(selector.from, entry),
      target,
      step: step.name,
    });
  }
  return origins;
}

function destination(step: Step): { registry: string; namespace: string } {
  const [registry = "", namespace = ""] = (step.to ?? "").split("/");
  return { registry, namespace };
}

function kindOfDir(dir: string): ArtifactKind | undefined {
  const leaf = basename(dir);
  for (const [kind, spec] of Object.entries(KIND_SPECS)) {
    if (spec.dir === leaf) return kind as ArtifactKind;
  }
  return undefined;
}

/** For the record only, not for behavior. */
function targetOf(from: string): string {
  const marker = /[\\/]\.([a-z0-9-]+)[\\/]/.exec(from);
  return marker?.[1] ?? "local";
}

function matches(pattern: string | undefined, name: string): boolean {
  if (pattern === undefined) return true;
  const negated = pattern.startsWith("!(") && pattern.endsWith(")");
  const body = negated ? pattern.slice(2, -1) : pattern;
  const expression = new RegExp(
    `^${body
      .split("|")
      .map((part) =>
        part
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, "."),
      )
      .join("|")}$`,
  );
  return negated ? !expression.test(name) : expression.test(name);
}

/** Read-only, so it runs before the lease and decides whether one is needed. */
async function settle(origin: Origin, lock: Lock): Promise<OriginOutcome> {
  if (!(await exists(origin.from))) return { origin, state: "missing", digest: undefined };
  const [refused] = (await authoredArtifact(origin.from)).irregular;
  if (refused !== undefined) {
    return { origin, state: "refused", digest: undefined, reason: refusedAt(origin, refused) };
  }
  const recorded = lock.artifacts[originKey(origin)];
  const now = await authoredDigest(origin.from, recorded?.digest);
  const unchanged = recorded?.origin !== undefined && recorded.digest === now;
  return { origin, state: unchanged ? "unchanged" : "refreshed", digest: now };
}

/** Worded the way publish words it. */
function refusedAt(origin: Origin, entry: Irregular): string {
  const at = entry.path === "" ? basename(origin.from) : `${basename(origin.from)}/${entry.path}`;
  return `${at} ${refusal(entry)}`;
}

/** The digest moves here, not after a publish: a failed publish then re-sends the same copy. */
export async function applyOrigins(
  outcomes: readonly OriginOutcome[],
  lock: Lock,
  roots: Roots,
): Promise<{ refreshed: string[]; refused: { name: string; reason: string }[] }> {
  const refreshed: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const outcome of outcomes) {
    if (outcome.state !== "refreshed" || outcome.digest === undefined) continue;

    const copy = artifactPath(
      roots,
      outcome.origin.registry,
      outcome.origin.namespace,
      outcome.origin.kind,
      outcome.origin.name,
      "",
    );
    // Never the other way round: the origin is read, the copy is written.
    if (resolve(copy) === resolve(outcome.origin.from)) continue;
    await assertManagedPath(copy, roots, { env: process.env });
    // Checked again as it copies: a link that appeared since the survey is refused, not followed.
    const irregular = await copyAuthored(outcome.origin.from, copy);
    if (irregular !== undefined) {
      refused.push({ name: outcome.origin.name, reason: refusedAt(outcome.origin, irregular) });
      continue;
    }
    const previous = lock.artifacts[originKey(outcome.origin)];
    lock.artifacts[originKey(outcome.origin)] = await rowFor(
      outcome.origin,
      copy,
      roots,
      outcome.digest,
      previous?.origin !== undefined &&
        previous.registry === outcome.origin.registry &&
        previous.kind === outcome.origin.kind
        ? previous
        : undefined,
    );
    // The key, so the row lands in the same write as its registry.
    refreshed.push(originKey(outcome.origin));
  }
  return { refreshed, refused };
}

async function rowFor(
  origin: Origin,
  copy: string,
  roots: Roots,
  digest: string,
  recorded: LockArtifact | undefined,
): Promise<LockArtifact> {
  // The authored folder is already where the target reads it, so nothing is linked over it.
  return {
    registry: origin.registry,
    id: recorded?.id,
    name: origin.name,
    kind: origin.kind,
    namespace: origin.namespace,
    address: recorded?.address,
    content: recorded?.content,
    version: recorded?.version,
    path: portable(roots, copy),
    digest,
    origin: {
      target: origin.target,
      path: portable(roots, origin.from),
      step: origin.step,
    },
    links: [],
  };
}

/** Relative to the scope base, in the one separator a lock is written with. */
function portable(roots: Roots, path: string): string {
  return posixRelative(canonical(roots.base), canonical(path));
}

/** A publish has landed once the registry serves exactly this copy. */
export function recordServed(
  lock: Lock,
  scan: Pick<Scan, "items" | "acquired">,
  names: Iterable<string>,
): void {
  const items = new Map(scan.items.map((item) => [item.name, item]));
  const sources = new Map(scan.acquired.map((source) => [source.alias, source]));
  for (const name of names) {
    const row = lock.artifacts[name];
    if (row?.origin === undefined) continue;
    if (items.get(name)?.disposition !== "synced") continue;
    const source = sources.get(row.registry);
    const at = source === undefined ? undefined : listedAt(row, source.catalog.entries);
    const placed = at === undefined ? undefined : source?.placements.get(at);
    if (at === undefined || placed === undefined) continue;
    row.id = placed.id;
    row.address = at;
    row.content = placed.contentId;
    row.version = placed.version;
  }
}

/** The folder itself stays; only rows and kept copies go. The caller holds the lease. */
export async function forgetOrigins(
  roots: Roots,
  registry: string,
  folders: readonly string[],
): Promise<string[]> {
  const lock = await readLock(roots);
  const watched = folders.map((folder) => canonical(folder));
  const forgotten: string[] = [];
  for (const [key, row] of Object.entries(lock.artifacts)) {
    if (row.origin === undefined || row.registry !== registry) continue;
    const from = canonical(resolve(roots.base, row.origin.path));
    if (!watched.some((folder) => isWithin(folder, from))) continue;
    // A pull of the same namespace links the copy into other targets, and they would dangle.
    for (const link of row.links) {
      const at = resolve(roots.base, link.path);
      if (canonical(at) !== from) await removeContained(at, roots, process.env);
    }
    await removeContained(resolve(roots.base, row.path), roots, process.env);
    delete lock.artifacts[key];
    forgotten.push(key);
  }
  if (forgotten.length > 0) await writeLock(roots, lock);
  return forgotten;
}

export interface Taken {
  name: string;
  folder: string;
  backup: string | undefined;
  written: boolean;
}

/**
 * The registry's copy replaces your folder, backed up first, or the next run would read the old
 * folder as an edit and send it back up.
 */
export async function takeIntoOrigins(
  roots: Roots,
  names: readonly string[],
  stamp: string,
): Promise<Taken[]> {
  const lock = await readLock(roots);
  const taken: Taken[] = [];
  for (const name of names) {
    const row = lock.artifacts[name];
    if (row?.origin === undefined) continue;
    const folder = resolve(roots.base, row.origin.path);
    const copy = resolve(roots.base, row.path);
    if (!(await exists(copy))) continue;
    let backup: string | undefined;
    if (await exists(folder)) {
      const copies = [{ from: folder, target: row.origin.target }];
      [backup] = (await moveAside(row.kind, basename(folder), copies, roots, stamp)).map(
        (moved) => moved.to,
      );
      // A folder aireg may not remove is never written over.
      if (backup === undefined) {
        taken.push({ name, folder, backup, written: false });
        continue;
      }
    }
    await copyAuthored(copy, folder);
    taken.push({ name, folder, backup, written: true });
  }
  return taken;
}
