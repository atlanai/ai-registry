import { isAdapterError } from "#adapter/index.ts";
import { list, quoted } from "#adapter/text.ts";
import { withheldMessage } from "#core/catalog/withheld.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type Lock, lockChanges } from "#core/lock.ts";
import { formatManifest } from "#core/manifest/format.ts";
import { newlyYanked } from "#core/plan/acquire/placement.ts";
import { blockedTargets } from "#core/plan/blocked-targets.ts";
import { clashMessage } from "#core/plan/build/build.ts";
import { leafOf, NAME_COLLISION_HINT, shownAddress } from "#core/plan/build/rename.ts";
import { describeCarried } from "#core/plan/carries.ts";
import type { Acquired, Kept, Plan } from "#core/plan/model.ts";
import { recordOf } from "#core/plan/model.ts";
import type { Untrusted } from "#core/plan/select.ts";
import { type Unlisted, unlistedMessage } from "#core/plan/unlisted.ts";
import { type Scope, scopeFlag } from "#core/store/paths.ts";
import { shellWord } from "#core/term/format.ts";
import type { Printer } from "#core/term/printer.ts";
import { VERSION } from "#core/version.ts";
import type { Loaded } from "#engine/scope/load.ts";
import { type ApplyNotice, unstagedNotices, warn } from "./notices.ts";

/** Skipping what the command named would report success for an install that never happened. */
export function refuseClash(plan: Plan, adding: ReadonlySet<string> | undefined): void {
  const clash = plan.clashes.find(({ dropped }) => adding?.has(dropped));
  if (clash === undefined) return;
  throw new AiregError(`${clashMessage(clash)}.`, {
    code: ErrorCode.Usage,
    hint: NAME_COLLISION_HINT,
  });
}

/** `fail` installs nothing at all, so a person picks before anything lands. */
export function refuseCollision(plan: Plan): void {
  const [clash] = plan.clashes;
  if (clash === undefined) return;
  const taken = leafOf(clash.name);
  throw new AiregError(
    `Nothing was installed: ${shownAddress(clash.dropped)} needs the name ${taken}, which ${shownAddress(clash.kept)} already has.`,
    { code: ErrorCode.Usage, hint: NAME_COLLISION_HINT },
  );
}

/** `--frozen` installs what the lock holds and refuses only a run that would change it. */
export function refuseLockChange(lock: Lock, plan: Plan): void {
  const changed = lockChanges(lock, recordOf(plan));
  if (changed.length === 0) return;
  throw new AiregError(`The lockfile would change for ${list(changed)}.`, {
    code: ErrorCode.Changed,
    hint: "Run the command without `--frozen`, and commit the result.",
  });
}

/** `--frozen` changes neither file, even when the lock would come out the same. */
export function refuseManifestChange(loaded: Loaded): void {
  if (formatManifest(loaded.manifest) === loaded.manifestAsRead) return;
  throw new AiregError("The manifest would change.", {
    code: ErrorCode.Changed,
    hint: "Run the command without `--frozen`, and commit the result.",
  });
}

/** Fails the run after the rest installed, so one bad artifact blocks nothing else. */
export function refuseUnstaged(
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
  // The adapter's code, as the cause, is what `--json` reports.
  throw new AiregError(`Did not install ${names}.`, {
    hint: `Run the command again once the registry serves them intact. ${rest}`,
    cause: unstaged.find((item) => isAdapterError(item.error))?.error,
  });
}

export function keptLines(kept: readonly Kept[]): string[] {
  return kept.map(({ name, installed, withheld }) => {
    const at = installed === undefined ? "as installed" : `at ${installed}`;
    return `${withheldMessage(withheld)}, so ${quoted(name)} was kept ${at}`;
  });
}

/**
 * A withheld copy stays installed. One this run was moving fails it once the rest is in; one it
 * only held is a warning, so an unrelated add still succeeds.
 */
export function refuseWithheld(
  plan: Plan,
  printer: Printer,
  moving: ReadonlySet<string> | undefined,
  scope: Scope,
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
    hint: removeHint(failed, scope),
  });
}

function absentLines(absent: readonly Kept[]): string[] {
  return absent.map(
    ({ name, withheld }) => `${withheldMessage(withheld)}, so ${quoted(name)} is not installed`,
  );
}

function removeHint(items: readonly { name: string }[], scope: Scope): string {
  const commands = items.map(({ name }) => `\`aireg remove ${name}${scopeFlag(scope)}\``);
  return `Run ${list(commands)} to take ${items.length === 1 ? "it" : "them"} out.`;
}

/**
 * An unlisted copy stays installed, never removed by a short listing. One this run was moving
 * fails it once the rest is in; one it only held is a warning.
 */
export function refuseUnlisted(
  unlisted: readonly Unlisted[],
  printer: Printer,
  moving: ReadonlySet<string> | undefined,
  scope: Scope,
): void {
  const moved = unlisted.filter((item) => moving?.has(item.name) === true);
  const held = unlisted.filter((item) => !moved.includes(item));
  for (const item of held) printer.warning(`${unlistedMessage(item)}.`);
  if (held.length > 0) printer.hint(removeHint(held, scope));
  if (moved.length === 0) return;
  throw new AiregError(`${list(moved.map(unlistedMessage))}.`, {
    code: ErrorCode.NotFound,
    hint: removeHint(moved, scope),
  });
}

export function untrustedLine(untrusted: readonly Untrusted[]): string {
  const carries = [...new Set(untrusted.flatMap((item) => item.carries))];
  const names = list(untrusted.map((item) => quoted(item.name)));
  return `${names}, which ${untrusted.length === 1 ? "carries" : "carry"} ${describeCarried(carries)}`;
}

export interface TrustRetry {
  scope: Scope;
  /** The address and source flags typed, when the run did not keep its registry declared. */
  address?: readonly string[] | undefined;
}

export function trustHint(untrusted: readonly Untrusted[], retry: TrustRetry): string {
  const scope = retry.scope === "user" ? " -g" : "";
  const commands = untrusted.map(({ registry, name }) => {
    const from =
      retry.address === undefined
        ? `${registry}/${name}`
        : `${retry.address.map(shellWord).join(" ")} -s ${name}`;
    return `\`aireg add ${from} --trust ${name}${scope}\``;
  });
  return `Read what ${untrusted.length === 1 ? "it runs" : "they run"}, then run ${list(commands)}.`;
}

/**
 * A plugin from a non-registry source carrying what a target runs as you installs only once
 * trusted by name; one left out fails the run after the rest is in.
 */
export function refuseUntrusted(untrusted: readonly Untrusted[], retry: TrustRetry): void {
  if (untrusted.length === 0) return;
  throw new AiregError(`Did not install ${untrustedLine(untrusted)} that run as you.`, {
    code: ErrorCode.Usage,
    hint: trustHint(untrusted, retry),
  });
}

/** Checked before a single byte is written. */
export function refusePlan(plan: Plan, acquired: readonly Acquired[], lock: Lock): void {
  refuseIncompatible(plan);
  refuseYanked(acquired, lock);
  refuseConflicts(plan);
}

function refuseIncompatible(plan: Plan): void {
  if (plan.incompatible.length === 0) return;
  const needing = plan.incompatible.map((item) => `${quoted(item.name)} (>= ${item.engine})`);
  const verb = needing.length === 1 ? "needs" : "need";
  throw new AiregError(`${list(needing)} ${verb} a newer aireg than ${VERSION}.`, {
    hint: "Run `aireg self update`.",
  });
}

const REWRITTEN_HINT =
  "Ask the registry's owner to publish the change as a new version; a released version never changes, so this may be tampering.";

/** The plan keeps each rewritten artifact as locked, so the rest still installs. */
export function rewrittenNotices(plan: Plan): ApplyNotice[] {
  if (plan.rewritten.length === 0) return [];
  const changed = plan.rewritten.map(
    (item) => `${quoted(item.name)} ${item.version} (locked ${item.locked}, now ${item.served})`,
  );
  const them = plan.rewritten.length === 1 ? "it" : "them";
  return [
    {
      message: `The registry serves different content for ${list(changed)}, so ${them} stayed as locked.`,
      hint: REWRITTEN_HINT,
    },
  ];
}

/** Fails the run after the rest installed, so a person still sees the integrity problem. */
export function refuseRewritten(plan: Plan): void {
  const [notice] = rewrittenNotices(plan);
  if (notice === undefined) return;
  throw new AiregError(notice.message, {
    code: ErrorCode.Integrity,
    hint: `${REWRITTEN_HINT} Everything else installed.`,
  });
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
 * An unwritable target root would fail partway through `apply`, with an errno naming a path but
 * not the target. Asking first leaves it untouched.
 */
export async function refuseBlocked(plan: Plan): Promise<void> {
  const blocked = await blockedTargets(plan);
  if (blocked.length === 0) return;
  const folders = blocked.map((item) => `${item.target} (${item.path})`);
  throw new AiregError(`Cannot write into the folder for ${list(folders)}.`, {
    hint: "Fix the folder's ownership or permissions, or leave the target out with `--for`.",
  });
}
