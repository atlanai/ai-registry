import { lstat, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { copyDescribed, reasonOf } from "#core/adapter/content.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { digest } from "#core/fs/digest.ts";
import { fanOut, link } from "#core/fs/link.ts";
import { PRIVATE_DIR } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { entries, exists, present, pruneEmptyParent, remove, unseal } from "#core/fs/tree.ts";
import { type Rendered, renderPlacement } from "#core/harness/render.ts";
import { assertLeasesHeld } from "#core/lease.ts";
import { type LinkMode, type Lock, readLock, writeLock } from "#core/lock.ts";
import { backupStamp } from "#core/store/backups.ts";
import { ensureScopeIgnore } from "#core/store/ignore.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import { PROJECTIONS_DIR, type Roots } from "#core/store/paths.ts";
import { assemble } from "./assemble.ts";
import { type Carried, carriedBy } from "./carries.ts";
import { backUp, guardLink, type LinkGuard } from "./link-guard.ts";
import type { Action, Fetch, Plan, Staged } from "./model.ts";
import { projectionsOf } from "./projection.ts";
import { applyRegistrations } from "./register.ts";
import { assertRemovable, removal, removeContained } from "./removable.ts";

interface Journal {
  /** Paths this run may have created. Recovery removes any the lock disowns. */
  writes: string[];
}

async function readJournal(path: string): Promise<Journal | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed)) {
      const writes = parsed.writes;
      if (Array.isArray(writes) && writes.every((item) => typeof item === "string")) {
        return { writes };
      }
    }
    throw new AiregError(`Invalid apply journal: ${path}`, { code: ErrorCode.Invalid });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export interface Recovered {
  /** What a crashed run wrote that the lock does not hold, now removed. */
  removed: string[];
  /** What it wrote that was left in place, because a link now stands on the way. */
  skipped: { path: string; reason: string }[];
}

/**
 * The lock is written last, so a crash leaves the previous lock and a journal of paths that may be
 * orphaned. Each entry is read once: one that cannot be removed safely is reported and left.
 */
export async function recover(
  roots: Roots,
  lock: Lock,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Recovered> {
  const journal = await readJournal(roots.applyJournal);
  const writes = (journal?.writes ?? []).map((path) => resolve(roots.cwd, path));
  const recovered: Recovered = { removed: [], skipped: [] };
  if (writes.length === 0) return recovered;

  // Staged paths as well as links: the journal records both, so claiming only
  // links would make recovery delete the artifact's only writable copy.
  const claimed = new Set<string>();
  for (const entry of Object.values(lock.artifacts)) {
    if (entry.path !== "") claimed.add(resolve(roots.base, entry.path));
    for (const item of entry.links) claimed.add(resolve(roots.base, item.path));
  }

  for (const path of writes.filter((write) => !claimed.has(write))) {
    const verdict = removal(path, roots, env);
    const reason =
      verdict.how === "refuse"
        ? verdict.reason
        : await guardManagedPath(path, roots, false, env).then(
            () => undefined,
            (error: unknown) => (error as Error).message.replace(/\.$/, ""),
          );
    if (reason !== undefined) {
      if (await present(path)) recovered.skipped.push({ path, reason });
      continue;
    }
    await removeContained(path, roots, env);
    recovered.removed.push(path);
  }
  await rm(roots.applyJournal, { force: true });
  return recovered;
}

/** The actions apply carries out; `record` only writes the lock. */
type Performed = Record<Exclude<Action["kind"], "record">, number>;

export interface ApplyResult {
  /** What ran: a link kept back for a person's own file, or never made, is not counted. */
  performed: Performed;
  /** Artifacts this run linked into a harness. */
  installed: string[];
  /** Artifacts the lock holds now that no harness had before this run. */
  added: string[];
  /** Artifacts some harness had before this run that none has now. */
  removed: string[];
  lock: Lock | undefined;
  /**
   * Harnesses that asked for a symlink and got a copy. Worth reporting: an edit
   * to the project's artifact no longer reaches that harness.
   */
  degraded: string[];
  /**
   * Artifacts, or members of one, the source would not serve intact. The run
   * installs the rest and keeps each one's previous lock row.
   */
  unstaged: { name: string; reason: string; error: unknown }[];
  /** Links not made: a person's own file or folder is at the destination, or `reason` says why. */
  kept: { name: string; path: string; reason?: string }[];
  /** A person's own file or folder that stood where a recorded link was, and where it was moved. */
  backedUp: {
    path: string;
    to: string;
    /** What it was, so the report can name it the way the person knows it. */
    what: "folder" | "file" | "link";
  }[];
  /** Plugins this run installed or updated that carry something a harness starts on its own. */
  carried: { name: string; carries: Carried[] }[];
  /** Rendered placements skipped because the artifact could not fill one. */
  unrendered: { name: string; harness: string; reason: string }[];
}

/** What a stage's content is keyed by, written once so both readers agree. */
const staged = (source: string, path: string): string => `${source}\0${path}`;

/** Enough to keep the transport busy; few enough that a failure stops the rest. */
const AHEAD = 24;

/** Fetches ahead of the loop, which still copies in plan order. */
function prefetch(plan: Plan, fetch: Fetch): (source: string, path: string) => Promise<Staged> {
  const stages = plan.actions.filter((action) => action.kind === "stage");
  const started = new Map<string, Promise<Staged>>();
  let next = 0;
  let taken = 0;

  const fill = (): void => {
    while (next < stages.length && next - taken < AHEAD) {
      const action = stages[next++] as Extract<Action, { kind: "stage" }>;
      const key = staged(action.source, action.path);
      if (started.has(key)) continue;

      const pending = fetch(action.source, action.path);
      pending.catch(() => {}); // Reported where it is awaited.

      started.set(key, pending);
    }
  };

  fill();
  return (source, path) => {
    taken += 1;
    fill();
    return started.get(staged(source, path)) ?? fetch(source, path);
  };
}

/** A link assembles a namespace's projection and no unlink takes it, so it goes with its last row. */
async function pruneProjections(wanted: ReadonlySet<string>, roots: Roots): Promise<void> {
  const root = join(roots.artifacts, PROJECTIONS_DIR);
  await guardManagedPath(root, roots);
  for (const { name: source } of await entries(root)) {
    await guardManagedPath(join(root, source), roots);
    for (const { name: plugin } of await entries(join(root, source))) {
      const path = join(root, source, plugin);
      await guardManagedPath(path, roots);
      if (!wanted.has(path)) await remove(path);
    }
    await rmdir(join(root, source)).catch(() => undefined);
  }
  await rmdir(root).catch(() => undefined);
}

/** How stale a run's knowledge that it still holds the lease may be. */
const LEASE_CHECK_MS = 250;

type ActionOf<K extends Action["kind"]> = Extract<Action, { kind: K }>;

/** What one run learns as it goes, read back when it writes the lock. */
interface Run {
  roots: Roots;
  ahead: (source: string, path: string) => Promise<Staged>;
  guards: Map<string, LinkGuard>;
  stamp: string | undefined;
  /** Digests are only known once content is on disk, so the lock is patched from these. */
  digests: Map<string, string>;
  /** Where a stage put the bytes, which is not a fixed path for every adapter. */
  materialized: Map<string, Staged>;
  /** Artifacts whose digest is settled; the first copy made is the one it describes. */
  measured: Set<string>;
  upstream: Map<string, string>;
  modes: Map<string, LinkMode>;
  // A plugin directory is shared by its namespace's artifacts but linked once, for
  // the first: every artifact linking that path takes the mode it got.
  pathModes: Map<string, LinkMode>;
  /** What each copy-mode link wrote, recorded so a later edit to it is seen. */
  copies: Map<string, string>;
  degraded: Set<string>;
  /** Projections to rebuild once every clone has landed: dir -> content, readers. */
  plugins: Map<string, { content: string; harnesses: Set<string> }>;
  /** Fan-out directories to refresh once their projections are final: dir -> projection. */
  fanned: Map<string, string>;
  /** Links whose source the source never served. */
  skipped: Set<string>;
  unstaged: Map<string, { reason: string; error: unknown }>;
  performed: Performed;
  installed: Set<string>;
  kept: ApplyResult["kept"];
  backedUp: ApplyResult["backedUp"];
  recorded: Lock | undefined;
  /** The lock as this run found it. */
  before: Lock | undefined;
  projections: ReadonlySet<string> | undefined;
  unrendered: ApplyResult["unrendered"];
}

const linkKey = (name: string, path: string): string => `${name} ${path}`;

/** Refuses the entire plan before journaling or starting any fetch. */
async function preflight(plan: Plan, roots: Roots): Promise<Map<string, LinkGuard>> {
  await guardManagedPath(roots.lock, roots);
  // Each folder is checked once here; every write checks its own path again as it happens.
  const checked = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind !== "record")
      await guardManagedPath(action.to, roots, action.kind !== "unlink", process.env, checked);
    if (action.kind === "link")
      await guardManagedPath(action.from, roots, true, process.env, checked);
  }
  return guardsOf(plan, roots);
}

/**
 * Decided before the journal, so recovery never counts a person's folder as ours to remove. A
 * recorded link a person has since replaced with their own is theirs: moved aside, never deleted.
 * Read-only, so a dry run shows the same verdicts.
 */
export async function guardsOf(plan: Plan, roots: Roots): Promise<Map<string, LinkGuard>> {
  const guards = new Map<string, LinkGuard>();
  for (const action of plan.actions) {
    if (action.kind === "record" || guards.has(action.to)) continue;
    if (action.kind === "link") {
      const rendered = await rendering(action);
      const text = rendered !== undefined && "text" in rendered ? rendered.text : undefined;
      guards.set(action.to, await guardLink(action.to, action.recorded, roots, text));
    } else if (action.kind === "unlink" && action.link !== undefined) {
      guards.set(action.to, await guardLink(action.to, action.link.mode, roots));
    }
  }
  return guards;
}

async function journal(plan: Plan, roots: Roots, guards: Map<string, LinkGuard>): Promise<void> {
  const writes = plan.actions
    .filter(
      (action): action is ActionOf<"stage" | "clone" | "link"> =>
        action.kind === "stage" || action.kind === "clone" || action.kind === "link",
    )
    .filter((action) => action.kind !== "link" || guards.get(action.to) !== "keep")
    .map((action) => action.to);
  if (writes.length === 0) return;
  // Owner-only, as aireg's home is, should this be the first thing written there.
  await mkdir(dirname(roots.applyJournal), { recursive: true, mode: PRIVATE_DIR });
  await writeAtomic(roots.applyJournal, JSON.stringify({ writes } satisfies Journal));
}

async function stage(run: Run, action: ActionOf<"stage">): Promise<void> {
  // One artifact the source cannot serve intact must not cost a person the
  // other twenty; clone, link and record already skip what was never staged.
  let from: Staged;
  try {
    // The only place bytes are waited for; a dry run never reaches here.
    from = await run.ahead(action.source, action.path);
  } catch (error) {
    run.unstaged.set(action.name, { reason: reasonOf(error), error });
    await guardManagedPath(action.to, run.roots, false);
    await remove(action.to);
    return;
  }
  // A collection that lost a member still installs; say which and why,
  // because the harness will simply not have that skill.
  for (const { member, reason, error } of from.dropped) {
    run.unstaged.set(`${action.name}/${member}`, { reason, error });
  }
  // Where this artifact's own bytes are: a version directory for a
  // directory-shaped kind, the one file inside it for a file-shaped one.
  run.materialized.set(action.name, from);
  run.upstream.set(action.name, from.contentId);
  run.performed.stage += 1;
}

async function cloneInto(run: Run, action: ActionOf<"clone">): Promise<void> {
  // Only bytes this run staged and checked are copied; a stage that failed left none.
  const from = run.materialized.get(action.name);
  if (from === undefined || !(await exists(from.path))) {
    run.skipped.add(linkKey(action.name, action.to));
    return;
  }
  await remove(action.to);
  // Only what the envelope describes lands, whatever else sits beside it.
  await copyDescribed(from, action.to);
  // This copy is the one a person is allowed to edit.
  await unseal(action.to);
  // The lock describes the copy, not the root: a file-shaped kind is a
  // directory upstream and a single file here, and the two never hash alike.
  if (!run.measured.has(action.name)) {
    run.measured.add(action.name);
    run.digests.set(action.name, await digest(action.to));
  }
  run.performed.clone += 1;
}

/** Pointing a harness at a whole namespace is what makes that directory a plugin. */
async function assemblePlugin(run: Run, action: ActionOf<"link">): Promise<void> {
  if (action.plugin !== true || action.content === undefined) return;
  if (!(await exists(action.content))) return;
  const found = run.plugins.get(action.from) ?? {
    content: action.content,
    harnesses: new Set<string>(),
  };
  found.harnesses.add(action.harness);
  run.plugins.set(action.from, found);
  await guardManagedPath(action.from, run.roots);
  await assemble(action.from, action.content, found.harnesses);
}

/** A rendered placement's text; undefined for a link, or before its source is copied. */
async function rendering(action: ActionOf<"link">): Promise<Rendered | undefined> {
  if (action.render === undefined) return undefined;
  const source = await readFile(action.from, "utf8").catch(() => undefined);
  return source === undefined ? undefined : renderPlacement(action.render, source);
}

/** Never linked: Codex refuses to run a linked agent. */
async function writeRendered(
  run: Run,
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
): Promise<LinkMode | undefined> {
  if (rendered === undefined || "problem" in rendered) {
    const reason = rendered?.problem ?? "its file could not be read";
    run.unrendered.push({ name: action.name, harness: action.harness, reason });
    return undefined;
  }
  await remove(action.to);
  await mkdir(dirname(action.to), { recursive: true });
  await writeAtomic(action.to, rendered.text);
  return "copy";
}

async function linkInto(run: Run, action: ActionOf<"link">): Promise<void> {
  const { roots } = run;
  const key = linkKey(action.name, action.to);
  let guard = run.guards.get(action.to) ?? "replace";
  // Its source may have been copied in by this run, after the guard was taken.
  const rendered = await rendering(action);
  if (guard === "keep" && rendered !== undefined && "text" in rendered) {
    guard = await guardLink(action.to, action.recorded, roots, rendered.text);
  }
  if (guard === "keep") {
    run.kept.push({ name: action.name, path: action.to });
    run.skipped.add(key);
    return;
  }
  // Assembled here, before the link that will read it.
  await assemblePlugin(run, action);
  // The source is inside our own tree, so a missing one was never staged.
  if (!(await exists(action.from))) {
    run.skipped.add(key);
    return;
  }
  // A committed symlink can appear on the way after planning; the write would follow it.
  const verdict = removal(action.to, roots);
  if (roots.scope === "project" && verdict.how === "refuse") {
    run.kept.push({ name: action.name, path: action.to, reason: verdict.reason });
    run.skipped.add(key);
    return;
  }
  // Whatever is there is about to go, so it is checked again now.
  await assertRemovable(action.to, roots);
  if (guard === "backup") {
    await moveAside(run, action.to, action.harness);
    run.guards.set(action.to, "replace");
  }
  // A harness that will not load a linked plugin gets a real directory of links instead.
  const fan = action.fan === true && !action.copy;
  const mode =
    action.render !== undefined
      ? await writeRendered(run, action, rendered)
      : fan
        ? await fanOut(action.from, action.to)
        : await link(action.from, action.to, action.copy);
  if (mode === undefined) {
    run.skipped.add(key);
    return;
  }
  if (fan) run.fanned.set(action.to, action.from);
  run.modes.set(key, mode);
  run.pathModes.set(action.to, mode);
  if (mode === "copy") run.copies.set(action.to, await digest(action.to));
  if (!action.copy && mode === "copy") run.degraded.add(action.harness);
  run.performed.link += 1;
  run.installed.add(action.name);
}

/** A person's own file or folder where the lockfile recorded a link goes to backups, never away. */
async function moveAside(run: Run, path: string, harness: string): Promise<void> {
  const { roots } = run;
  const info = await lstat(path);
  run.stamp ??= backupStamp();
  await guardManagedPath(roots.artifacts, roots);
  run.backedUp.push({
    path,
    to: await backUp(path, harness, roots, run.stamp),
    what: info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : "file",
  });
}

async function unlink(run: Run, action: ActionOf<"unlink">): Promise<void> {
  if (run.guards.get(action.to) === "backup" && action.link !== undefined) {
    await assertRemovable(action.to, run.roots);
    await moveAside(run, action.to, action.link.harness);
  } else {
    await removeContained(action.to, run.roots);
  }
  // The kind subdir is ours to tidy; the namespace above it is not, outside the store.
  await pruneEmptyParent(action.to, run.roots.artifacts);
  run.performed.unlink += 1;
}

/** A row that failed to restage keeps what the lock held; one it never held is not recorded. */
async function keepUnstaged(run: Run, lock: Lock): Promise<void> {
  if (run.unstaged.size === 0) return;
  const held = run.before;
  for (const name of run.unstaged.keys()) {
    const previous = held?.artifacts[name];
    if (previous === undefined) {
      delete lock.artifacts[name];
      continue;
    }
    lock.artifacts[name] = previous;
    const source = held?.registries[previous.registry];
    if (source !== undefined) lock.registries[previous.registry] ??= source;
  }
}

function patchRow(run: Run, name: string, entry: Lock["artifacts"][string]): void {
  const { roots } = run;
  const fresh = run.digests.get(name);
  if (fresh !== undefined) entry.digest = fresh;
  // The identity the store keyed it by, which is what `basis` looks up.
  const identity = run.upstream.get(name);
  if (identity !== undefined) entry.content = identity;
  // Prune reads this list, so a link that was never made must not be
  // in it: the member it would have pointed at does not exist.
  const blocked = entry.links.filter((item) =>
    run.kept.some((held) => held.name === name && held.path === resolve(roots.base, item.path)),
  );
  const held = [
    ...(entry.blocked ?? []),
    ...blocked.map(({ harness, path }) => ({ harness, path })),
  ];
  entry.blocked = held.length === 0 ? undefined : held;
  entry.links = entry.links.filter(
    (item) => !run.skipped.has(linkKey(name, resolve(roots.base, item.path))),
  );
  for (const item of entry.links) {
    const at = resolve(roots.base, item.path);
    const mode = run.modes.get(linkKey(name, at)) ?? run.pathModes.get(at);
    if (mode !== undefined) item.mode = mode;
    // A plugin folder is linked once, for its first member, and installs every member it serves.
    if (run.pathModes.has(at)) run.installed.add(name);
    const written = run.copies.get(at);
    if (written !== undefined) item.digest = written;
  }
}

async function record(run: Run, action: ActionOf<"record">): Promise<void> {
  // Taken first: a row whose restage failed may still have links reading its projection.
  run.projections = projectionsOf(action.lock, run.roots);
  await keepUnstaged(run, action.lock);
  for (const [name, entry] of Object.entries(action.lock.artifacts)) {
    if (!run.unstaged.has(name)) patchRow(run, name, entry);
  }
  await writeLock(run.roots, action.lock);
  run.recorded = action.lock;
}

function perform(run: Run, action: Action): Promise<void> {
  switch (action.kind) {
    case "stage":
      return stage(run, action);
    case "clone":
      return cloneInto(run, action);
    case "link":
      return linkInto(run, action);
    case "unlink":
      return unlink(run, action);
    case "record":
      return record(run, action);
  }
}

/** Work that needs every clone landed first, then the store's housekeeping. */
async function finish(run: Run, plan: Plan): Promise<void> {
  const { roots } = run;
  // At link time a projection would see only the kind whose artifact happened to be first.
  for (const [dir, { content, harnesses }] of run.plugins) {
    await guardManagedPath(dir, roots);
    await assemble(dir, content, harnesses);
  }
  for (const [to, from] of run.fanned) {
    await assertRemovable(to, roots);
    await fanOut(from, to);
  }
  if (run.projections !== undefined) await pruneProjections(run.projections, roots);
  if (run.plugins.size > 0 || Object.values(run.performed).some((count) => count > 0)) {
    await guardManagedPath(roots.artifacts, roots);
    await ensureScopeIgnore(roots);
  }
  run.kept.push(...(await applyRegistrations(plan.actions, roots)));
}

const linked = (lock: Lock | undefined, name: string): number =>
  lock?.artifacts[name]?.links.length ?? 0;

export async function apply(
  plan: Plan,
  roots: Roots,
  fetch: Fetch,
  onStep?: (action: Action) => void,
): Promise<ApplyResult> {
  const guards = await preflight(plan, roots);
  const before = await readLock(roots);
  await journal(plan, roots, guards);
  const run: Run = {
    roots,
    ahead: prefetch(plan, fetch),
    guards,
    stamp: undefined,
    digests: new Map(),
    materialized: new Map(),
    measured: new Set(),
    upstream: new Map(),
    modes: new Map(),
    pathModes: new Map(),
    copies: new Map(),
    degraded: new Set(),
    plugins: new Map(),
    fanned: new Map(),
    skipped: new Set(),
    unstaged: new Map(),
    performed: { stage: 0, clone: 0, link: 0, unlink: 0 },
    installed: new Set(),
    kept: [],
    backedUp: [],
    recorded: undefined,
    before,
    projections: undefined,
    unrendered: [],
  };

  let leaseCheckedAt = 0;
  for (const action of plan.actions) {
    // Reading the lease per action is a file read each; the lock write checks it again regardless.
    if (action.kind === "record" || Date.now() - leaseCheckedAt >= LEASE_CHECK_MS) {
      await assertLeasesHeld();
      leaseCheckedAt = Date.now();
    }
    onStep?.(action);
    if (action.kind !== "record")
      await guardManagedPath(action.to, roots, action.kind !== "unlink");
    await perform(run, action);
  }
  await finish(run, plan);

  await rm(roots.applyJournal, { force: true });
  return {
    performed: run.performed,
    installed: [...run.installed].sort(),
    added: Object.keys(run.recorded?.artifacts ?? {})
      .filter((name) => linked(before, name) === 0)
      .sort(),
    removed:
      run.recorded === undefined
        ? []
        : Object.keys(before?.artifacts ?? {})
            .filter((name) => linked(before, name) > 0 && linked(run.recorded, name) === 0)
            .sort(),
    lock: run.recorded,
    degraded: [...run.degraded].sort(),
    unstaged: [...run.unstaged].map(([name, { reason, error }]) => ({ name, reason, error })),
    kept: run.kept,
    backedUp: run.backedUp,
    carried: await carriedBy(plan, run.recorded, roots),
    unrendered: run.unrendered,
  };
}
