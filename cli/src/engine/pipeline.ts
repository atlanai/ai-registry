import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import { isAdapterError, type Want } from "#adapter/index.ts";
import { list, quoted, sanitizeText } from "#adapter/text.ts";
import { loadAdapter } from "#core/adapter/registry.ts";
import { withheldAt, withheldMessage } from "#core/catalog/withheld.ts";
import { type NameCollision, nameCollisionOf } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { dict } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { canonical } from "#core/fs/canonical.ts";
import { homeDir, readTextIfPresent } from "#core/fs/path.ts";
import { DEFAULT_TARGETS, type Harnesses, names, resolveHarnesses } from "#core/harness/index.ts";
import { loadHarnessFiles } from "#core/harness/load.ts";
import { runPipelineHooks } from "#core/hook/run.ts";
import { type LeaseHolder, withLease } from "#core/lease.ts";
import { type Lock, lockChanges, readLock } from "#core/lock.ts";
import { formatManifest, type Manifest, readManifest, writeManifest } from "#core/manifest.ts";
import type { Printer } from "#core/output.ts";
import { acquire, answers, lockView, newlyYanked } from "#core/plan/acquire.ts";
import { type ApplyResult, apply, guardsOf, type Recovered, recover } from "#core/plan/apply.ts";
import { leafOf, NAME_COLLISION_HINT, shownAddress } from "#core/plan/build/rename.ts";
import { build, clashMessage } from "#core/plan/build.ts";
import { describeCarried } from "#core/plan/carries.ts";
import { formatNeed, type Unresolved, wantOf } from "#core/plan/depends.ts";
import type { Acquired, Action, Kept, Plan } from "#core/plan/model.ts";
import { fetchFrom } from "#core/plan/model.ts";
import { wrappedInLock, wrapsNamespaces } from "#core/plan/namespaces.ts";
import type { Untrusted } from "#core/plan/select.ts";
import { survey } from "#core/plan/survey.ts";
import { type Unlisted, unlistedMessage } from "#core/plan/unlisted.ts";
import { blockedTargets } from "#core/plan/writable.ts";
import { unmetEngine } from "#core/semver.ts";
import {
  MANIFEST_FILE,
  roots as makeRoots,
  type Roots,
  SCOPE_DIR,
  type Scope,
  userScopeDir,
} from "#core/store/paths.ts";
import { displayPath } from "#core/sync/adopt.ts";
import { VERSION } from "#core/version.ts";
import type { CommonOptions } from "./options.ts";

/** Where a command acts: its scope, and the directory that scope is rooted at. */
export interface Located {
  scope: Scope;
  base: string;
}

/** What a command does outside any project when no scope was named. */
export type Outside = "user" | "fail";

/**
 * Like git finding its repository: the closest folder with a `.registry/` manifest,
 * else the repository root. Undefined outside both.
 */
export function locate(explicit: Scope | undefined, cwd: string): Located | undefined {
  if (explicit === "user") return { scope: "user", base: cwd };
  const project = projectRoot(cwd);
  if (project !== undefined) return { scope: explicit ?? "project", base: project };
  return explicit === undefined ? undefined : { scope: explicit, base: cwd };
}

function projectRoot(cwd: string): string | undefined {
  const user = userScopeDir();
  const home = homeDir();
  let dir = cwd;
  for (;;) {
    const own = join(dir, SCOPE_DIR);
    // Home's `.registry/` is a user scope even when AIREG_USER_SCOPE points elsewhere, so it
    // never makes home a project.
    const manifest = existsSync(join(own, MANIFEST_FILE)) && canonical(dir) !== home;
    const marked = manifest || existsSync(join(dir, ".git"));
    if (marked && canonical(own) !== user) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveScope(
  explicit: Scope | undefined,
  cwd: string,
  outside: Outside = "fail",
): Located {
  const located = locate(explicit, cwd);
  if (located !== undefined) return located;
  if (outside === "user") return { scope: "user", base: cwd };
  throw new AiregError("Not in a project.", {
    code: ErrorCode.Usage,
    hint: "Run it inside a repository, or pass `-g` for your user scope.",
  });
}

export interface Loaded {
  roots: Roots;
  manifest: Manifest;
  lock: Lock;
  /** The built-in table; nothing a project or user writes changes it. */
  harnesses: Harnesses;
  /** The manifest as loaded, so a run that did not edit it leaves the file alone. */
  manifestAsRead: string;
}

export function scopeRoots(common: CommonOptions, cwd: string, outside: Outside = "fail"): Roots {
  const { scope, base } = resolveScope(common.scope, cwd, outside);
  return makeRoots(scope, base);
}

export async function load(
  common: CommonOptions,
  cwd: string,
  outside: Outside = "fail",
): Promise<Loaded> {
  return read(scopeRoots(common, cwd, outside));
}

/**
 * Holds the scope's lease and reads it under the lease, so a change another process
 * wrote meanwhile is kept, not overwritten. One writer per scope, across processes.
 */
export async function withScope<T>(
  roots: Roots,
  run: (loaded: Loaded) => Promise<T>,
  printer?: Printer,
): Promise<T> {
  const onWaiting =
    printer === undefined
      ? undefined
      : (holder: LeaseHolder | undefined) => waiting(printer, roots.scope, holder);
  return withLease(roots, { wait: true, onWaiting }, async () => run(await read(roots)));
}

async function read(roots: Roots): Promise<Loaded> {
  const lock = await readLock(roots);
  const manifest = await readManifest(roots.manifest);
  const harnesses = resolveHarnesses();
  return { roots, manifest, lock, harnesses, manifestAsRead: formatManifest(manifest) };
}

/** Explicit flag wins, then the manifest, then what is installed on the machine. */
export function resolveTargets(
  manifest: Manifest,
  harnesses: Harnesses,
  common: CommonOptions,
): string[] {
  const wanted = common.targets ?? (manifest.targets.length > 0 ? manifest.targets : undefined);
  if (wanted === undefined) return [...DEFAULT_TARGETS];
  if (wanted.includes("*")) return names(harnesses);

  const known = new Set(names(harnesses));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    // From --for it is the command line; from the manifest it is file content.
    // A file of yours that would define one, but was skipped, is the likelier story.
    const skipped = loadHarnessFiles().skipped.filter((file) =>
      unknown.some((name) => basename(file.path) === `${name}.json`),
    );
    throw new AiregError(`No harness named ${list(unknown.map(quoted), "or")}.`, {
      code: common.targets === undefined ? ErrorCode.Invalid : ErrorCode.Usage,
      hint:
        skipped.length > 0
          ? `aireg skipped ${list(skipped.map((file) => file.path))}: run \`aireg harnesses\` to see why.`
          : `Use ${list(names(harnesses), "or")}, or run \`aireg harnesses\` to see which this machine has.`,
    });
  }
  return wanted;
}

export interface RunResult {
  plan: Plan;
  /** What apply did; absent for a dry run, or a plan that was not approved. */
  applied: ApplyResult | undefined;
  /** The lockfile as the run found it, so a report can say what moved. */
  before: Lock;
  /** The harnesses this run installed for, so a report names them as they were chosen. */
  targets: readonly string[];
  harnesses: Harnesses;
  scope: Scope;
}

export interface RunHooks {
  /**
   * Asked once the plan is known and before a single byte is written.
   * Returning false leaves the project untouched.
   */
  approve?: ((plan: Plan, targets: readonly string[]) => Promise<boolean>) | undefined;
  /** Re-read every source instead of trusting what the lock pins. */
  refresh?: boolean;
  /** Lock rows this run takes the registry's newest of; every other row installs as locked. */
  moving?: ReadonlySet<string>;
  /** Registries this run changes; the others are left as the lock has them, unopened. */
  aliases?: readonly string[];
  /** Take nothing the lock does not hold, so a removal never installs what was published since. */
  held?: boolean;
  /** Edited rows this run may delete, which `remove` settles before planning. */
  discard?: ReadonlySet<string>;
  /** Artifacts this run names: one left out for another's name is refused, not skipped. */
  adding?: ReadonlySet<string>;
  /** Installed names whose identical copy already on disk this run takes over in place. */
  adopt?: ReadonlySet<string>;
}

/** The harnesses a run installs for, so a report can name them as they were chosen. */
export interface Chosen {
  targets: readonly string[];
  harnesses: Harnesses;
}

/** How a run is shown, which the caller decides: the engine only says what happens. */
export interface PlanReport {
  /** The whole plan, for a dry run, and the paths a real run would move to backups. */
  plan(plan: Plan, roots: Roots, aside: ReadonlySet<string>, chosen: Chosen): void;
  /** Each action as apply reaches it. */
  step(action: Action, plan: Plan, chosen: Chosen): void;
}

/** The single install path: `add`, `update` and `remove` differ only in `edit`. */
export async function run(
  roots: Roots,
  common: CommonOptions,
  printer: Printer,
  cwd: string,
  report: PlanReport,
  edit: (loaded: Loaded) => RunHooks | Promise<RunHooks> = () => ({}),
): Promise<RunResult> {
  return withScope(
    roots,
    async (loaded) => write(loaded, common, printer, cwd, report, await edit(loaded)),
    printer,
  );
}

/** Said at once, without --verbose: a silent wait reads as a hang. */
function waiting(printer: Printer, scope: Scope, holder: LeaseHolder | undefined): void {
  const who = holder === undefined ? `another aireg process` : `aireg (pid ${holder.pid})`;
  const where = scope === "user" ? "your user scope" : "this project";
  printer.warning(`Waiting for ${who} to finish writing ${where}.`);
  printer.hint(
    `Wait for it to finish, or run \`aireg unlock${scope === "user" ? " -g" : ""}\` if it has stopped.`,
  );
}

function refuseIncompatible(plan: Plan): void {
  if (plan.incompatible.length === 0) return;
  const needing = plan.incompatible.map((item) => `${quoted(item.name)} (>= ${item.engine})`);
  const verb = needing.length === 1 ? "needs" : "need";
  throw new AiregError(`${list(needing)} ${verb} a newer aireg than ${VERSION}.`, {
    hint: "Run `aireg self update`.",
  });
}

/** Skipping what the command named would report success for an install that never happened. */
function refuseClash(plan: Plan, adding: ReadonlySet<string> | undefined): void {
  const clash = plan.clashes.find(({ dropped }) => adding?.has(dropped));
  if (clash === undefined) return;
  throw new AiregError(`${clashMessage(clash)}.`, {
    code: ErrorCode.Usage,
    hint: NAME_COLLISION_HINT,
  });
}

/** `fail` installs nothing at all, so a person picks before anything lands. */
function refuseCollision(plan: Plan): void {
  const [clash] = plan.clashes;
  if (clash === undefined) return;
  const taken = leafOf(clash.name);
  throw new AiregError(
    `Nothing was installed: ${shownAddress(clash.dropped)} needs the name ${taken}, which ${shownAddress(clash.kept)} already has.`,
    { code: ErrorCode.Usage, hint: NAME_COLLISION_HINT },
  );
}

function refuseRewritten(plan: Plan): void {
  if (plan.rewritten.length === 0) return;
  const changed = plan.rewritten.map(
    (item) => `${quoted(item.name)} ${item.version} (locked ${item.locked}, now ${item.served})`,
  );
  throw new AiregError(
    `The registry serves different content for ${list(changed)}, so nothing was installed.`,
    {
      code: ErrorCode.Integrity,
      hint: "Ask the registry's owner to publish the change as a new version; a released version never changes, so this may be tampering.",
    },
  );
}

/** A lock that holds a yanked version keeps it; nothing new may pin one. */
function refuseYanked(acquired: readonly Acquired[], lock: Lock): void {
  const yanked = newlyYanked(acquired, lock);
  if (yanked.length === 0) return;
  throw new AiregError(`${list(yanked)}, so nothing was installed.`, {
    hint: "Pin another version, or leave the version off for the latest; a yanked version installs only where the lockfile already holds it.",
  });
}

function refuseConflicts(plan: Plan): void {
  const [first] = plan.conflicts;
  if (first !== undefined) {
    throw new AiregError(first.message, { code: ErrorCode.Conflict, hint: first.hint });
  }
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

export function recordOf(plan: Plan): Lock {
  const record = plan.actions.find(
    (action): action is Extract<Action, { kind: "record" }> => action.kind === "record",
  );
  if (record === undefined) throw new Error("The plan has no lockfile record.");
  return record.lock;
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

/** `--frozen` installs what the lock holds and refuses only a run that would change it. */
function refuseLockChange(lock: Lock, plan: Plan): void {
  const changed = lockChanges(lock, recordOf(plan));
  if (changed.length === 0) return;
  throw new AiregError(`The lockfile would change for ${list(changed)}.`, {
    code: ErrorCode.Changed,
    hint: "Run the command without `--frozen`, and commit the result.",
  });
}

/** `--frozen` changes neither file, even when the lock would come out the same. */
function refuseManifestChange(loaded: Loaded): void {
  if (formatManifest(loaded.manifest) === loaded.manifestAsRead) return;
  throw new AiregError("The manifest would change.", {
    code: ErrorCode.Changed,
    hint: "Run the command without `--frozen`, and commit the result.",
  });
}

/** What did not land fails the run, after the rest installed, so one bad artifact blocks nothing else. */
function refuseUnstaged(
  unstaged: readonly { name: string; reason: string; error: unknown }[],
  landed: boolean,
  printer: Printer,
): void {
  if (unstaged.length === 0) return;
  warn(printer, unstagedNotices(unstaged));
  const names = list(unstaged.map((item) => item.name));
  const rest = landed
    ? "Everything else installed, and the lockfile keeps the versions it held for these."
    : "Nothing was installed.";
  throw new AiregError(`Did not install ${names}.`, {
    hint: `Run the command again once the registry serves them intact. ${rest}`,
    // The adapter's code is what `--json` reports.
    cause: unstaged.find((item) => isAdapterError(item.error))?.error,
  });
}

/** Why each kept copy stays: `pr-review 1.2.0 is blocked (...), so pr-review stays at 1.1.0`. */
function keptLines(kept: readonly Kept[]): string[] {
  return kept.map(({ name, installed, withheld }) => {
    const at = installed === undefined ? "as installed" : `at ${installed}`;
    return `${withheldMessage(withheld)}, so ${quoted(name)} was kept ${at}`;
  });
}

/**
 * A copy the registry now withholds stays installed. A blocked one this run was moving fails it,
 * once the rest is in; one it only held is a warning, so an unrelated add still succeeds.
 */
function refuseWithheld(
  plan: Plan,
  printer: Printer,
  moving: ReadonlySet<string> | undefined,
): void {
  const absent = plan.withheld.filter((item) => item.absent);
  const blocked = plan.withheld.filter(
    (item) => !item.absent && item.withheld.status === "blocked" && moving?.has(item.name) === true,
  );
  const failed = [...absent, ...blocked];
  for (const line of keptLines(plan.withheld.filter((item) => !failed.includes(item)))) {
    printer.warning(`${line}.`);
  }
  if (failed.length === 0) return;
  const lines = [...absentLines(absent), ...keptLines(blocked)];
  throw new AiregError(`${list(lines)}.`, {
    code: ErrorCode.Invalid,
    hint: removeHint(failed.map(({ name }) => name)),
  });
}

function absentLines(absent: readonly Kept[]): string[] {
  return absent.map(
    ({ name, withheld }) => `${withheldMessage(withheld)}, so ${quoted(name)} is not installed`,
  );
}

/** The commands that take each kept row out, said once for all of them. */
function removeHint(names: readonly string[]): string {
  const commands = names.map((name) => `\`aireg remove ${name}\``);
  return `Run ${list(commands)} to take ${names.length === 1 ? "it" : "them"} out.`;
}

/**
 * A copy its registry stopped listing stays installed, never removed by a short listing. One this
 * run was moving fails it, once the rest is in; one it only held is a warning.
 */
function refuseUnlisted(
  unlisted: readonly Unlisted[],
  printer: Printer,
  moving: ReadonlySet<string> | undefined,
): void {
  const moved = unlisted.filter((item) => moving?.has(item.name) === true);
  const held = unlisted.filter((item) => !moved.includes(item));
  for (const item of held) printer.warning(`${unlistedMessage(item)}.`);
  if (held.length > 0) printer.hint(removeHint(held.map((item) => item.name)));
  if (moved.length === 0) return;
  throw new AiregError(`${list(moved.map(unlistedMessage))}.`, {
    code: ErrorCode.NotFound,
    hint: removeHint(moved.map((item) => item.name)),
  });
}

/** `"deploy-kit", which carries hooks and MCP servers`, for what was left out for want of trust. */
function untrustedLine(untrusted: readonly Untrusted[]): string {
  const carries = [...new Set(untrusted.flatMap((item) => item.carries))];
  const names = list(untrusted.map((item) => quoted(item.name)));
  return `${names}, which ${untrusted.length === 1 ? "carries" : "carry"} ${describeCarried(carries)}`;
}

/** The command that trusts each plugin, by the address that installs it. */
function trustHint(untrusted: readonly Untrusted[]): string {
  const commands = untrusted.map(
    ({ registry, name }) => `\`aireg add ${registry}/${name} --trust ${name}\``,
  );
  return `Read what ${untrusted.length === 1 ? "it runs" : "they run"}, then run ${list(commands)}.`;
}

/**
 * A plugin from a source that is not a registry carrying what a harness runs as you installs only
 * once trusted by name; one left out fails the run after the rest is in.
 */
function refuseUntrusted(untrusted: readonly Untrusted[]): void {
  if (untrusted.length === 0) return;
  throw new AiregError(`Did not install ${untrustedLine(untrusted)} that run as you.`, {
    code: ErrorCode.Usage,
    hint: trustHint(untrusted),
  });
}

function refuseOldCli(engine: string | undefined): void {
  const why = unmetEngine(VERSION, engine);
  if (why === undefined) return;
  throw new AiregError(`This project ${why}.`, { hint: "Run `aireg self update`." });
}

/**
 * The lock is the source of truth: a registry it fully answers is planned
 * from it, and its registry is opened only for what the lock cannot supply.
 */
async function plan(
  loaded: Loaded,
  common: CommonOptions,
  printer: Printer,
  cwd: string,
  hooks: RunHooks,
  targets: readonly string[],
  nameCollision: NameCollision,
): Promise<{ planned: Plan; acquired: Acquired[] }> {
  const { roots, manifest, lock, harnesses } = loaded;
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
        wrappedInLock(view.rows(alias), { roots, harnesses }),
      ));
    settled.set(alias, { ...source, namespacePlugins });
  }
  // Only a registry being opened needs its account, which may refresh a token.
  const open = async (only: readonly string[]) =>
    acquire(manifest, {
      base: roots.base,
      aliases: only,
      onStep: (message) => printer.step(message),
      credentials: await credentialsForManifest(
        Object.fromEntries(
          Object.entries(manifest.registries).filter(([alias]) => only.includes(alias)),
        ),
        cwd,
      ),
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
        harnesses,
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

async function closeAll(sources: readonly Acquired[]): Promise<void> {
  await Promise.allSettled(sources.map((source) => source.close()));
}

/** What every writing run settles before it plans: an engine this CLI meets, and a crashed run's leftovers. */
/** Something an apply did to a person's files, or left undone, worded once for every caller. */
export interface ApplyNotice {
  message: string;
  hint?: string;
}

export function recoveredNotices(roots: Roots, recovered: Recovered): ApplyNotice[] {
  return recovered.skipped.map(({ path, reason }) => ({
    message: `An interrupted run left ${displayPath(roots, path)} behind, and it was not removed: ${sanitizeText(reason)}.`,
  }));
}

export function appliedNotices(
  roots: Roots,
  applied: ApplyResult,
  harnesses: Harnesses,
): ApplyNotice[] {
  const notices: ApplyNotice[] = applied.backedUp.map((moved) => ({
    message: `Moved your ${moved.what} ${displayPath(roots, moved.path)} to ${displayPath(roots, moved.to)}.`,
  }));
  for (const { name, path } of applied.adopted) {
    notices.push({
      message: `Took over ${displayPath(roots, path)}, which already held ${name} as aireg installs it.`,
    });
  }
  if (applied.degraded.length > 0) {
    notices.push({
      message: `Copied into ${list(applied.degraded)} instead of linking, because this platform refused a symlink.`,
      hint: "Edits to the project's copy will not reach those harnesses until you sync.",
    });
  }
  for (const { name, path, reason } of applied.kept) {
    notices.push({
      message:
        reason === undefined
          ? keptMessage(roots, name, path, "Did not")
          : `Did not install ${name} at ${displayPath(roots, path)}: ${sanitizeText(reason)}.`,
    });
  }
  for (const { name, harness, reason } of applied.unrendered) {
    notices.push({
      message: `Did not install ${name} for ${displayName(harnesses, harness)}: ${reason}.`,
    });
  }
  return notices;
}

function keptMessage(roots: Roots, name: string, path: string, verb: string): string {
  return `${verb} install ${name}, because ${displayPath(roots, path)} already holds something of yours.`;
}

/** A tool by its name, and a shared folder by its path, as the summary names them. */
function displayName(harnesses: Harnesses, harness: string): string {
  const target = harnesses[harness];
  if (target === undefined) return harness;
  return target.shared ? target.projectRoot : target.displayName;
}

export function unstagedNotices(unstaged: Readonly<ApplyResult["unstaged"]>): ApplyNotice[] {
  return unstaged.map(({ name, reason }) => ({ message: `Skipped ${name}: ${reason}` }));
}

function warn(printer: Printer, notices: readonly ApplyNotice[]): void {
  for (const { message, hint } of notices) {
    printer.warning(message);
    if (hint !== undefined) printer.hint(hint);
  }
}

export async function prepareWrite({ manifest, roots, lock }: Loaded): Promise<Recovered> {
  refuseOldCli(manifest.engine);
  return recover(roots, lock);
}

/** The refusals every plan passes before a single byte is written. */
export function refusePlan(plan: Plan, acquired: readonly Acquired[], lock: Lock): void {
  refuseIncompatible(plan);
  refuseRewritten(plan);
  refuseYanked(acquired, lock);
  refuseConflicts(plan);
}

/**
 * A harness root the run cannot write into fails partway through `apply`,
 * with an errno naming a path but not the harness. Asking first leaves it untouched.
 */
export async function refuseBlocked(plan: Plan): Promise<void> {
  const blocked = await blockedTargets(plan);
  if (blocked.length === 0) return;
  const folders = blocked.map((item) => `${item.harness} (${item.path})`);
  throw new AiregError(`Cannot write into the folder for ${list(folders)}.`, {
    hint: "Fix the folder's ownership or permissions, or leave the harness out with `--for`.",
  });
}

/** Applies a refused-clean plan between the user's apply hooks; `undo` runs when it fails. */
export async function commit(
  loaded: Loaded,
  plan: Plan,
  acquired: readonly Acquired[],
  targets: readonly string[],
  onStep: (action: Action) => void,
  undo: () => Promise<void> = async () => {},
): Promise<ApplyResult> {
  const event = { targets: [...targets], aliases: Object.keys(loaded.manifest.registries) };
  let applied: ApplyResult;
  try {
    await runPipelineHooks("preApply", event);
    applied = await apply(plan, loaded.roots, fetchFrom(acquired), onStep);
  } catch (error) {
    await undo();
    throw error;
  }
  await runPipelineHooks("postApply", event);
  return applied;
}

async function write(
  loaded: Loaded,
  common: CommonOptions,
  printer: Printer,
  cwd: string,
  report: PlanReport,
  hooks: RunHooks,
): Promise<RunResult> {
  const { roots, manifest, lock, harnesses } = loaded;

  warn(printer, recoveredNotices(roots, await prepareWrite(loaded)));

  const targets = resolveTargets(manifest, harnesses, common);
  // Reports name every tool picked, including those an entry's own `harnesses:` adds.
  const named = [
    ...new Set([
      ...targets,
      ...manifest.artifacts.flatMap((ref) => ref.targets ?? []).filter((name) => name in harnesses),
    ]),
  ];
  const collision = nameCollisionOf(await readConfig());
  const { planned, acquired } = await plan(loaded, common, printer, cwd, hooks, targets, collision);
  try {
    if (collision === "fail") refuseCollision(planned);
    refuseClash(planned, hooks.adding);
    for (const warning of planned.warnings) {
      printer.warning(warning.message);
      if (warning.hint !== undefined) printer.hint(warning.hint);
    }
    refusePlan(planned, acquired, lock);
    if (common.frozen) {
      refuseLockChange(lock, planned);
      refuseManifestChange(loaded);
    }

    if (common.dryRun) {
      const guards = await guardsOf(planned, roots);
      const aside = new Set(
        [...guards].flatMap(([path, guard]) => (guard === "backup" ? [path] : [])),
      );
      // Said before the run, so an agent can move a person's folder out of the way first.
      for (const action of planned.actions) {
        if (action.kind === "link" && guards.get(action.to) === "keep")
          printer.warning(keptMessage(roots, action.name, action.to, "Would not"));
      }
      report.plan(planned, roots, aside, { targets: named, harnesses });
      for (const line of keptLines(planned.withheld)) printer.warning(`${line}.`);
      refuseUnlisted(planned.unlisted, printer, undefined);
      if (planned.untrusted.length > 0) {
        printer.warning(`Would not install ${untrustedLine(planned.untrusted)} that run as you.`);
        printer.hint(trustHint(planned.untrusted));
      }
      return {
        plan: planned,
        applied: undefined,
        before: lock,
        targets: named,
        harnesses,
        scope: roots.scope,
      };
    }

    await refuseBlocked(planned);

    if (hooks.approve !== undefined && !(await hooks.approve(planned, named))) {
      return {
        plan: planned,
        applied: undefined,
        before: lock,
        targets: named,
        harnesses,
        scope: roots.scope,
      };
    }

    const edited = formatManifest(manifest) !== loaded.manifestAsRead;
    // Read under the restore's lease, so only this run's edit is undone.
    const before = edited ? await readTextIfPresent(roots.manifest) : undefined;
    const written = edited ? await writeManifest(roots, manifest) : undefined;
    const applied = await commit(
      loaded,
      planned,
      acquired,
      targets,
      (action) => report.step(action, planned, { targets: named, harnesses }),
      async () => {
        // Nothing was recorded, so the manifest must not ask for it.
        if (edited && (await unrecorded(roots, lock)))
          await restore(roots.manifest, before, written);
      },
    );

    warn(printer, appliedNotices(roots, applied, harnesses));

    const landed = applied.installed.length > 0;
    // An edit none of whose artifacts landed, whether unstaged or left out for want of trust,
    // must not leave the manifest asking for them.
    if (edited && !landed && (applied.unstaged.length > 0 || planned.untrusted.length > 0))
      await restore(roots.manifest, before, written);
    refuseUnstaged(applied.unstaged, landed, printer);
    refuseWithheld(planned, printer, hooks.moving);
    refuseUnlisted(planned.unlisted, printer, hooks.moving);
    refuseUntrusted(planned.untrusted);
    return { plan: planned, applied, before: lock, targets: named, harnesses, scope: roots.scope };
  } finally {
    await closeAll(acquired);
  }
}

/** Undoes this run's write only; a file someone changed since is left as they wrote it. */
async function restore(
  path: string,
  before: string | undefined,
  written: string | undefined,
): Promise<void> {
  if ((await readTextIfPresent(path)) !== written) return;
  if (before === undefined) await rm(path, { force: true });
  else await writeAtomic(path, before);
}

/** Whether the lock on disk is still the one the run started from. */
async function unrecorded(roots: Roots, lock: Lock): Promise<boolean> {
  return readLock(roots).then(
    (now) => lockChanges(lock, now).length === 0,
    () => false,
  );
}
