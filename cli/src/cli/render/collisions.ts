import { ExitCode } from "#core/errors.ts";
import { leafOf, NAME_COLLISION_HINT, shownAddress } from "#core/plan/build/rename.ts";
import type { Plan, Renamed } from "#core/plan/model.ts";
import type { Printer } from "#core/term/printer.ts";

/** An artifact left out because another holds its name. */
export interface Unlinked {
  artifact: string;
  by: string;
  /** The path both would take, when they differ in name but not in where they land. */
  at?: string;
}

/** One artifact left out means the install is not whole, so it exits 3. */
export function exitOnClash(context: { exit?: ExitCode }, plan: Plan): void {
  if (plan.clashes.length > 0) context.exit = ExitCode.Changed;
}

export function reportCollisions(printer: Printer, plan: Plan): void {
  if (printer.format === "json") return;
  for (const { artifact, as, by } of plan.renamed) {
    const why = `${leafOf(artifact)} is taken by ${shownAddress(by)}`;
    printer.note("renamed", `${shownAddress(artifact)} to ${as}, because ${why}`);
  }
  for (const { name, kept, dropped, at, container } of plan.clashes) {
    const taken = container === true ? `the plugin folder ${at}` : leafOf(name);
    printer.note(
      "skipped",
      `${shownAddress(dropped)}, because ${taken} is taken by ${shownAddress(kept)}`,
    );
  }
  // Renaming an artifact never frees a plugin folder, so the setting is no fix for that clash.
  const renameable = plan.clashes.some((clash) => clash.container !== true);
  if (plan.renamed.length > 0 || renameable) printer.hint(NAME_COLLISION_HINT);
}

export function collisionFields(plan: Plan): { renamed?: Renamed[]; unlinked?: Unlinked[] } {
  return {
    ...(plan.renamed.length === 0 ? {} : { renamed: plan.renamed }),
    ...(plan.clashes.length === 0
      ? {}
      : {
          unlinked: plan.clashes.map(({ dropped, kept, at }) => ({
            artifact: dropped,
            by: kept,
            ...(at === undefined ? {} : { at }),
          })),
        }),
  };
}
