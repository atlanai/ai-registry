import { relative } from "node:path";
import { list, plural } from "#adapter/text.ts";
import type { Lock } from "#core/lock.ts";
import type { Printer } from "#core/output.ts";
import type { ApplyResult } from "#core/plan/apply.ts";
import { describeCarried } from "#core/plan/carries.ts";
import type { Action, Plan } from "#core/plan/model.ts";
import { olderThan } from "#core/semver.ts";
import type { Roots } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { GLYPH } from "#core/term/theme.ts";
import type { PlanReport, RunResult } from "#engine/pipeline.ts";
import { underHome } from "./home.ts";

type Shown = Exclude<Action, { kind: "record" }>;

/** What each action does for the person, rather than how it is done. */
const VERB: Record<Shown["kind"], string> = {
  stage: "fetch",
  clone: "copy",
  link: "install",
  unlink: "uninstall",
};

/** One line per action as it happens, naming the harness so four links read apart. */
function describeAction(action: Shown): string {
  if (action.kind === "link") return `install ${action.name} into ${action.harness}`;
  if (action.kind === "clone") return `copy ${action.name} into this project`;
  return `${VERB[action.kind]} ${action.name}`;
}

/** The same value a real run executes, printed instead of performed. */
function renderPlan(printer: Printer, plan: Plan, roots: Roots, aside: ReadonlySet<string>): void {
  const shown = plan.actions.filter((action): action is Shown => action.kind !== "record");
  // Your user scope is your home folder, so its paths read from there.
  const shownPath = (path: string): string =>
    roots.scope === "user" ? underHome(path) : relative(roots.base, path) || path;

  if (shown.length === 0) {
    printer.info("Nothing to do.");
    return;
  }

  const { style } = printer;
  // Said once per artifact, on its first line.
  const first = new Set(shown.map((action) => shown.find((other) => other.name === action.name)));
  const verb = (action: Shown): string =>
    action.kind === "unlink" && aside.has(action.to) ? "move aside" : VERB[action.kind];
  const note = (action: Shown): string => {
    // A fetch lands in aireg's own cache, so where it comes from is what a person can use.
    if (action.kind === "stage") return style.dim(`from ${action.source}`);
    if (aside.has(action.to)) return style.yellow("yours, kept in backups");
    if (action.kind === "unlink" && action.edited === true) return style.yellow("has local edits");
    if (!first.has(action)) return "";
    const by = plan.neededBy[action.name];
    if (by !== undefined) return style.dim(`needed by ${by.join(", ")}`);
    return plan.pruned.includes(action.name) ? style.dim("no longer needed") : "";
  };
  printer.info(style.bold(plural(shown.length, "change")));
  table(
    printer,
    [
      {
        header: "action",
        value: (action: Shown) =>
          action.kind === "unlink" ? style.yellow(verb(action)) : style.cyan(verb(action)),
      },
      { header: "artifact", value: (action: Shown) => action.name },
      {
        header: "harness",
        value: (action: Shown) => (action.kind === "link" ? action.harness : ""),
        optional: true,
      },
      {
        header: "path",
        value: (action: Shown) => (action.kind === "stage" ? "" : style.dim(shownPath(action.to))),
      },
      { header: "note", value: note, optional: true },
    ],
    shown,
  );
  // Only an install brings anything up to date; a removal leaves the rest as they were.
  const acted = new Set(shown.map((action) => action.name));
  const others = plan.unchanged.filter((name) => !acted.has(name));
  if (others.length > 0 && shown.some((action) => action.kind !== "unlink")) {
    printer.info(style.dim(`  ${plural(others.length, "other artifact")} already up to date`));
  }
  // Said plainly, because the list above is identical to what a real run does
  // and a dry run that ends in a success line reads as a completed one.
  printer.info(style.dim("Dry run. Nothing was changed."));
}

/** `reviewer needs`, `reviewer and triage need`. */
export function whoNeeds(by: readonly string[]): string {
  return `${list(by)} need${by.length === 1 ? "s" : ""}`;
}

/** Up to three names, else a count, so a large install still reads as one line. */
function named(names: readonly string[]): string {
  return names.length <= 3 ? list(names) : plural(names.length, "artifact");
}

/**
 * "Up to date" is false when something was deliberately left alone, and the
 * pin can advance while no content moves. Say only what is certain.
 */
function unchanged(printer: Printer, plan: Plan): void {
  if (plan.warnings.length === 0) {
    printer.success("Already up to date.");
    return;
  }
  const names = [...new Set(plan.warnings.flatMap((w) => (w.name ? [w.name] : [])))];
  printer.info(
    printer.style.dim(
      names.length === 0
        ? "Nothing was changed."
        : `Left ${list(names)} as ${names.length === 1 ? "it is" : "they are"}, and changed nothing else.`,
    ),
  );
}

/** An applied run: the plan, what apply did, and the lockfile it started from. */
export type Ran = Pick<RunResult, "plan" | "before"> & { applied: ApplyResult };

/**
 * Names what apply did, not what was planned: a link kept for a file of yours is not one.
 * `told` are artifacts the command has already reported on, which are not named again.
 */
export function summarize(
  printer: Printer,
  { plan, applied, before }: Ran,
  told: ReadonlySet<string> = new Set(),
): void {
  const shown = plan.actions.filter(
    (action): action is Shown => action.kind !== "record" && !told.has(action.name),
  );
  const touched = (...kinds: Shown["kind"][]) =>
    new Set(shown.flatMap((action) => (kinds.includes(action.kind) ? [action.name] : [])));
  const held = applied.lock?.artifacts;
  // A namespace installs through one link, so the lock, not the link, says where each one went.
  const harnessesOf = (name: string) =>
    held?.[name]?.links.map((item) => item.harness) ??
    shown.flatMap((action) =>
      action.kind === "link" && action.name === name ? [action.harness] : [],
    );
  const installed = applied.added.filter((name) => harnessesOf(name).length > 0);
  const changed = [...touched("clone", "link", "unlink")].filter(
    (name) => !applied.added.includes(name) && !applied.removed.includes(name),
  );
  const lines = Object.values(applied.performed).some((count) => count > 0)
    ? [
        installed.length > 0
          ? `Installed ${named(installed)} into ${list([...new Set(installed.flatMap(harnessesOf))])}.`
          : "",
        ...changeLines(changed, shown, before, held),
        applied.removed.length > 0 ? `Removed ${named(applied.removed)}.` : "",
      ].filter((line) => line !== "")
    : [];
  if (lines.length === 0) {
    if (told.size === 0) unchanged(printer, plan);
    return;
  }
  for (const line of lines) printer.success(line);
  const acted = touched("clone", "link", "unlink", "stage");
  for (const [name, by] of Object.entries(plan.neededBy)) {
    if (acted.has(name)) printer.note("with", `${name}, which ${whoNeeds(by)}`);
  }
  for (const name of plan.pruned) {
    if (acted.has(name)) printer.note("gone", `${name}, which is no longer needed`);
  }
  // Instructions wait for an agent to read them; these run as you once a harness loads them.
  for (const { name, carries } of applied.carried) {
    const where = harnessesOf(name);
    if (told.has(name) || where.length === 0) continue;
    printer.note("runs", `${describeCarried(carries)} from ${name}, in ${list(where)}`);
  }
}

/**
 * What happened to installed artifacts a run changed: a new version, links into a
 * harness only put back, or anything else.
 */
function changeLines(
  names: readonly string[],
  shown: readonly Shown[],
  before: Lock,
  after: Lock["artifacts"] | undefined,
): string[] {
  const moved: string[] = [];
  const back: string[] = [];
  const restored: string[] = [];
  const updated: string[] = [];
  for (const name of names) {
    const from = before.artifacts[name];
    const to = after?.[name]?.version;
    if (from?.version !== undefined && to !== undefined && from.version !== to) {
      (olderThan(to, from.version) ? back : moved).push(
        `${name} ${from.version} ${GLYPH.arrow} ${to}`,
      );
      continue;
    }
    // Only what the lockfile already held was put back: its content fetched again, or a link it records.
    const puts = shown
      .filter((action) => action.name === name)
      .every(
        (action) =>
          action.kind === "stage" ||
          action.kind === "clone" ||
          (action.kind === "link" && from?.links.some((link) => link.harness === action.harness)),
      );
    (from !== undefined && puts ? restored : updated).push(name);
  }
  const relinked = [
    ...new Set(
      shown.flatMap((action) =>
        action.kind === "link" && restored.includes(action.name) ? [action.harness] : [],
      ),
    ),
  ];
  return [
    moved.length > 0
      ? `Updated ${moved.length <= 3 ? list(moved) : plural(moved.length, "artifact")}.`
      : "",
    back.length > 0
      ? `Rolled back ${back.length <= 3 ? list(back) : plural(back.length, "artifact")}.`
      : "",
    updated.length > 0 ? `Updated ${named(updated)}.` : "",
    restored.length > 0
      ? `Restored ${named(restored)}${relinked.length === 0 ? "" : ` in ${list(relinked)}`}.`
      : "",
  ];
}

/** A run's result under `--json`; a dry run reports what it would change, in the same fields. */
export function outcome({ plan, applied }: RunResult, dryRun: boolean) {
  const planned = plan.actions.filter((action) => action.kind !== "record");
  return {
    dryRun,
    changed:
      applied === undefined
        ? planned.length
        : Object.values(applied.performed).reduce((sum, count) => sum + count, 0),
    installed:
      applied?.installed ??
      [
        ...new Set(planned.flatMap((action) => (action.kind === "link" ? [action.name] : []))),
      ].sort(),
    kept: applied?.kept ?? [],
  };
}

/** How an installing command shows a run: each step as it happens, or the whole plan for a dry run. */
export function planReport(printer: Printer): PlanReport {
  return {
    plan: (plan, roots, aside) => renderPlan(printer, plan, roots, aside),
    step: (action) => {
      if (action.kind !== "record") printer.step(describeAction(action));
    },
  };
}
