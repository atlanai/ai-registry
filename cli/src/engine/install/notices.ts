import { list, sanitizeText } from "#adapter/text.ts";
import type { Recovered } from "#core/plan/apply/journal.ts";
import type { ApplyResult } from "#core/plan/apply/run.ts";
import type { Roots } from "#core/store/paths.ts";
import { displayPath } from "#core/sync/adopt.ts";
import type { Targets } from "#core/target/contract.ts";
import type { Printer } from "#core/term/printer.ts";

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
  targetTable: Targets,
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
      hint: "Edits to the project's copy will not reach those targets until you sync.",
    });
  }
  for (const kept of applied.kept) notices.push({ message: keptNotice(roots, kept) });
  for (const { name, target, reason } of applied.unrendered) {
    notices.push({
      message: `Did not install ${name} for ${displayName(targetTable, target)}: ${reason}.`,
    });
  }
  return notices;
}

function keptNotice(roots: Roots, kept: ApplyResult["kept"][number]): string {
  const { name, path, reason, config } = kept;
  if (reason === undefined) return keptMessage(roots, name, path, "Did not");
  const shown = displayPath(roots, path);
  // Registration runs for removals too, so it names the file it left rather than an install.
  if (config === true) return `Left ${shown} as it is for ${name}: ${sanitizeText(reason)}.`;
  return `Did not install ${name} at ${shown}: ${sanitizeText(reason)}.`;
}

/** A tool by its name, and a shared folder by its path, as the summary names them. */
function displayName(targetTable: Targets, name: string): string {
  const target = targetTable[name];
  if (target === undefined) return name;
  return target.shared ? target.projectRoot : target.displayName;
}

export function keptMessage(roots: Roots, name: string, path: string, verb: string): string {
  return `${verb} install ${name}, because ${displayPath(roots, path)} already holds something of yours.`;
}

export function unstagedNotices(unstaged: Readonly<ApplyResult["unstaged"]>): ApplyNotice[] {
  return unstaged.map(({ name, reason }) => ({ message: `Skipped ${name}: ${reason}` }));
}

export function warn(printer: Printer, notices: readonly ApplyNotice[]): void {
  for (const { message, hint } of notices) {
    printer.warning(message);
    if (hint !== undefined) printer.hint(hint);
  }
}
