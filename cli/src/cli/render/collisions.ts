import { ExitCode } from "#core/errors.ts";
import type { Printer } from "#core/output.ts";
import { leafOf, NAME_COLLISION_HINT, shownAddress } from "#core/plan/build/rename.ts";
import type { Plan } from "#core/plan/model.ts";

/**
 * Each artifact a run renamed or left out because another holds its name, and the setting
 * that decides it. One left out means the install is not whole, so it exits 3.
 */
export function settleCollisions(context: { printer: Printer; exit?: ExitCode }, plan: Plan): void {
  if (plan.clashes.length > 0) context.exit = ExitCode.Changed;
  const { printer } = context;
  if (printer.format === "json") return;
  for (const { artifact, as, by } of plan.renamed) {
    const why = `${leafOf(artifact)} is taken by ${shownAddress(by)}`;
    printer.note("renamed", `${shownAddress(artifact)} to ${as}, because ${why}`);
  }
  for (const { name, kept, dropped } of plan.clashes) {
    const why = `${leafOf(name)} is taken by ${shownAddress(kept)}`;
    printer.note("skipped", `${shownAddress(dropped)}, because ${why}`);
  }
  if (plan.renamed.length > 0 || plan.clashes.length > 0) printer.hint(NAME_COLLISION_HINT);
}

/** The same, for `--json`: `renamed`, and `unlinked` for what was left out. */
export function collisionFields(plan: Plan) {
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
