import { list, plural } from "#adapter/text.ts";
import type { BackupList, BackupRestore, SkipReason } from "#cli/commands/backup/result.ts";
import { BACKUP_COMMAND } from "#cli/commands/backup/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import {
  cancel,
  type Interaction,
  interaction,
  interactive,
  preparing,
  silence,
} from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { confirm, select } from "#cli/prompt/select.ts";
import { underHome } from "#cli/render/home.ts";
import { toolName } from "#cli/render/tools.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { originOf, putBack, type Standing, standing } from "#core/plan/restore.ts";
import {
  type BackupItem,
  type BackupRun,
  backupStamp,
  backupsDir,
  listBackups,
} from "#core/store/backups.ts";
import { type Scope, scopeFlag, scopeName } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import { resolveTargets } from "#core/target/table.ts";
import { clock, day } from "#core/term/format.ts";
import type { Printer, Styler } from "#core/term/printer.ts";
import { tableLines } from "#core/term/table.ts";
import type { CommonOptions } from "#engine/options.ts";
import { withScope } from "#engine/scope/load.ts";
import { scopeRoots } from "#engine/scope/locate.ts";
import type { CommandContext } from "./command.ts";
import { action, defineCommand, STREAMED } from "./define.ts";

interface Options {
  stamp: string | undefined;
  common: CommonOptions;
}

interface Listed {
  data: BackupList;
  targetTable: Targets;
}

interface Planned {
  item: BackupItem;
  standing: Standing;
  /** Asked on a terminal: what stands there moves to a new run. */
  replace: boolean;
}

export const { run } = defineCommand<Options>({
  spec: BACKUP_COMMAND,
  parse(argv) {
    const { positionals, common } = parse(argv, BACKUP_COMMAND);
    const [verb = "list", stamp] = positionals;
    return { action: verb, options: { stamp, common } };
  },
  actions: {
    list: action({
      run: ({ common }, context) => listRuns(common, context),
      data: ({ data }) => data,
      text: ({ data, targetTable }, printer) => listText(data, targetTable, printer),
    }),
    restore: action({
      run: restore,
      text: restoreText,
    }),
  },
});

async function listRuns(common: CommonOptions, context: CommandContext): Promise<Listed> {
  const roots = scopeRoots(common, context.cwd, "user");
  const env = process.env;
  const targetTable = resolveTargets(env);
  const runs = await listBackups(roots);
  return {
    targetTable,
    data: {
      scope: roots.scope,
      root: backupsDir(roots),
      runs: runs.map((run) => ({
        stamp: run.stamp,
        ...(run.atMs === undefined ? {} : { at: new Date(run.atMs).toISOString() }),
        counts: counts(run),
        items: run.items.map((item) => {
          const origin = originOf(item, targetTable, roots, env);
          return {
            name: item.name,
            target: item.target,
            dir: item.dir,
            path: item.path,
            ...(origin === undefined ? {} : { origin }),
          };
        }),
      })),
    },
  };
}

function counts(run: BackupRun): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of run.items) out[item.target] = (out[item.target] ?? 0) + 1;
  return out;
}

function listText(data: BackupList, targetTable: Targets, printer: Printer): void {
  const { style } = printer;
  if (data.runs.length === 0) {
    printer.info(`Nothing is in ${scopeName(data.scope)}'s backups.`);
    if (data.scope === "project")
      printer.hint("Run `aireg backup list -g` to see your user scope's.");
    return;
  }
  data.runs.forEach((run, index) => {
    if (index > 0) printer.info();
    const when = run.at === undefined ? "" : `  ${style.dim(whenOf(Date.parse(run.at)))}`;
    printer.info(
      `${style.bold(run.stamp)}${when}  ${style.dim(countsLine(run.counts, targetTable))}`,
    );
    for (const line of tableLines(
      style,
      [
        { header: "item", value: (item: (typeof run.items)[number]) => style.cyan(item.name) },
        { header: "from", value: (item) => toolName(targetTable, item.target) },
        {
          header: "goes back to",
          value: (item) =>
            item.origin === undefined ? style.dim("unknown") : underHome(item.origin),
        },
      ],
      run.items,
    )) {
      printer.info(line);
    }
  });
  printer.hint(`Run \`aireg backup restore${scopeFlag(data.scope)} <stamp>\` to put a run back.`);
}

function whenOf(atMs: number): string {
  return `${day(atMs)} ${clock(atMs)}`;
}

function countsLine(byTarget: Record<string, number>, targetTable: Targets): string {
  return Object.entries(byTarget)
    .map(([target, n]) => `${toolName(targetTable, target)} ${n}`)
    .join(", ");
}

async function restore(
  { stamp, common }: Options,
  context: CommandContext,
): Promise<BackupRestore | typeof STREAMED> {
  const step = interaction(context.printer, defaultIo(), common.yes);
  if (stamp === undefined) preparing(step);
  const roots = scopeRoots(common, context.cwd, "user");
  const env = process.env;
  const targetTable = resolveTargets(env);
  const runs = await listBackups(roots);
  if (runs.length === 0) {
    throw new AiregError(`Nothing is in ${scopeName(roots.scope)}'s backups.`, {
      code: ErrorCode.NotFound,
      ...(roots.scope === "project"
        ? { hint: "Run `aireg backup list -g` to see your user scope's." }
        : {}),
    });
  }
  const chosen = await chooseRun(step, runs, stamp, roots.scope, targetTable);
  if (chosen === undefined) {
    cancel(step);
    return STREAMED;
  }

  const plan: Planned[] = [];
  for (const item of chosen.items) {
    plan.push({ item, standing: await standing(item, targetTable, roots, env), replace: false });
  }
  if (interactive(step)) {
    for (const entry of plan) {
      if (entry.standing.state !== "taken") continue;
      const answer = await askReplace(step, entry.item, entry.standing.to);
      if (canceled(answer)) {
        cancel(step);
        return STREAMED;
      }
      entry.replace = answer;
    }
    const going = plan.filter(restorable).length;
    if (going > 0) {
      const proceed = await confirm(
        {
          message: `Restore ${plural(going, "item")} from ${chosen.stamp}?`,
          style: step.printer.errStyle,
          body: planLines(step.printer.errStyle, plan, targetTable),
        },
        step.io,
      );
      if (canceled(proceed) || !proceed) {
        cancel(step);
        return STREAMED;
      }
    }
  }

  const asked = interactive(step);
  return withScope(
    roots,
    async () => {
      const result: BackupRestore = {
        scope: roots.scope,
        stamp: chosen.stamp,
        restored: [],
        skipped: [],
      };
      let aside: string | undefined;
      for (const { item, replace } of plan) {
        // Checked again under the lease: an install may have taken the path since the question.
        const now = await standing(item, targetTable, roots, env);
        const named = { name: item.name, target: item.target };
        if (now.state === "unknown") {
          result.skipped.push({ ...named, reason: "unknown", detail: item.path });
          continue;
        }
        if (now.state === "refused") {
          result.skipped.push({ ...named, path: now.to, reason: "refused", detail: now.reason });
          continue;
        }
        if (now.state === "installed" || (now.state === "taken" && !replace)) {
          const declined: SkipReason = asked ? "kept" : "taken";
          const reason = now.state === "installed" ? "installed" : declined;
          result.skipped.push({ ...named, path: now.to, reason });
          continue;
        }
        const back = await putBack(item, now.to, roots, env, () => {
          aside ??= backupStamp();
          return aside;
        });
        result.restored.push({
          ...named,
          path: back.to,
          ...(back.replaced === undefined ? {} : { replaced: back.replaced }),
        });
      }
      return result;
    },
    context.printer,
  );
}

function restorable({ standing: at, replace }: Planned): boolean {
  return at.state === "free" || (at.state === "taken" && replace);
}

async function chooseRun(
  step: Interaction,
  runs: readonly BackupRun[],
  stamp: string | undefined,
  scope: Scope,
  targetTable: Targets,
): Promise<BackupRun | undefined> {
  if (stamp !== undefined) {
    const found = runs.find((run) => run.stamp === stamp);
    if (found !== undefined) return found;
    throw new AiregError(`No backup run ${stamp} in ${scopeName(scope)}.`, {
      code: ErrorCode.NotFound,
      hint: `Run \`aireg backup list${scopeFlag(scope)}\` to see the runs.`,
    });
  }
  if (!interactive(step)) {
    throw needsInput(
      "backup restore",
      "a run",
      `Name one: \`aireg backup restore${scopeFlag(scope)} <stamp>\`; \`aireg backup list${scopeFlag(scope)}\` shows them. No list was offered because ${silence(step)}.`,
    );
  }
  const picked = await select<string>(
    {
      message: "Restore which run?",
      style: step.printer.errStyle,
      options: runs.map((run) => ({
        value: run.stamp,
        label: run.stamp,
        hint: [
          ...(run.atMs === undefined ? [] : [whenOf(run.atMs)]),
          `${plural(run.items.length, "item")} from ${list(
            Object.keys(counts(run)).map((target) => toolName(targetTable, target)),
          )}`,
        ].join(" · "),
      })),
    },
    step.io,
  );
  return canceled(picked) ? undefined : runs.find((run) => run.stamp === picked);
}

/** Keeping is the default: replacing moves what is there now, which a person may not expect. */
async function askReplace(step: Interaction, item: BackupItem, to: string) {
  return select<boolean>(
    {
      message: `${underHome(to)} is taken. Restore ${item.name} over it?`,
      style: step.printer.errStyle,
      initial: false,
      options: [
        { value: false, label: "Keep current", hint: "the backup stays where it is", key: "k" },
        {
          value: true,
          label: "Replace current",
          hint: "the current one moves to a new backup",
          key: "r",
        },
      ],
    },
    step.io,
  );
}

function planLines(style: Styler, plan: readonly Planned[], targetTable: Targets): string[] {
  return tableLines(
    style,
    [
      { header: "item", value: ({ item }: Planned) => style.cyan(item.name) },
      { header: "from", value: ({ item }) => toolName(targetTable, item.target) },
      {
        header: "goes back to",
        value: ({ standing: at }) =>
          at.state === "unknown" ? style.dim("unknown") : underHome(at.to),
      },
      { header: "", value: (entry) => planNote(style, entry), optional: true },
    ],
    plan,
    { indent: 0 },
  );
}

function planNote(style: Styler, { standing: at, replace }: Planned): string {
  switch (at.state) {
    case "free":
      return "";
    case "taken":
      return replace
        ? style.yellow("the current one moves to a new backup")
        : style.dim("kept: the current one stays");
    case "installed":
      return style.dim("skipped: aireg installs an artifact there");
    case "refused":
      return style.dim(`skipped: ${at.reason}`);
    case "unknown":
      return style.dim("skipped: aireg cannot tell where it came from");
  }
}

function restoreText(result: BackupRestore, printer: Printer): void {
  for (const item of result.restored) {
    const moved =
      item.replaced === undefined ? "" : `; the one there is now in ${underHome(item.replaced)}`;
    printer.success(`Restored ${underHome(item.path)}${moved}.`);
  }
  const reasons = new Set<SkipReason>();
  for (const item of result.skipped) {
    reasons.add(item.reason);
    printer.warning(`Left ${item.name} in backups: ${skipText(item)}.`);
  }
  const flag = scopeFlag(result.scope);
  if (reasons.has("taken")) {
    printer.hint(
      `Run \`aireg backup restore${flag} ${result.stamp}\` in a terminal to choose whether to replace what is there.`,
    );
  }
  if (reasons.has("installed")) {
    printer.hint(
      `Run \`aireg remove${flag} <name>\` for what aireg installed there, then restore again.`,
    );
  }
}

function skipText({ path, reason, detail }: BackupRestore["skipped"][number]): string {
  const at = path === undefined ? "" : underHome(path);
  switch (reason) {
    case "kept":
      return `you kept ${at}`;
    case "taken":
      return `${at} is taken`;
    case "installed":
      return `aireg installs an artifact at ${at}`;
    case "refused":
      return detail ?? `aireg may not write to ${at}`;
    case "unknown":
      return `aireg cannot tell which folder it came from${detail === undefined ? "" : `; it is in ${underHome(detail)}`}`;
  }
}
