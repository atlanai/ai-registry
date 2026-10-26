import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { list as listed, plural, quoted } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import { foundBy } from "#cli/render/found.ts";
import { underHome } from "#cli/render/home.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { targetsDir } from "#core/store/paths.ts";
import {
  canonicalId,
  type Detection,
  detectAll,
  resolveTargets,
  type Target,
} from "#core/target/index.ts";
import { BUILT_IN, checkTargetText, loadTargetFiles } from "#core/target/load.ts";
import { table } from "#core/term/table.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { builtin, type CommandContext, runAction } from "./index.ts";

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, builtin("targets"));
  const [action, argument] = positionals;
  if (action === undefined) return list(context, common.all);
  return runAction(builtin("targets"), action, {
    show: async () =>
      show(
        context,
        needed(argument, "show", "a target id", "Run `aireg targets` to see every id."),
      ),
    check: async () =>
      check(
        context,
        needed(
          argument,
          "check",
          "a file",
          "Name the file to check: `aireg targets check <file>`.",
        ),
      ),
  });
}

function needed(argument: string | undefined, action: string, what: string, hint: string): string {
  if (argument !== undefined) return argument;
  throw new AiregError(`\`aireg targets ${action}\` needs ${what}.`, {
    code: ErrorCode.Usage,
    hint,
  });
}

/** Where a target came from, as a person reads it. */
function origin(path: string): string {
  return path === BUILT_IN ? "built in" : underHome(path);
}

/** Files in your user scope aireg could not use; the built-ins keep working without them. */
function warnSkipped(context: CommandContext): void {
  for (const file of loadTargetFiles().skipped) {
    const problems = file.problems.join(" ");
    context.printer.warning(
      `Skipped ${underHome(file.path)}: ${problems.charAt(0).toLowerCase()}${problems.slice(1)}`,
    );
  }
}

/** Each target and what detected it: env, binary, then directories. */
async function list(context: CommandContext, all: boolean): Promise<void> {
  // Every name `--for` takes; a shared folder such as `.agents` is never detected.
  const targetTable = resolveTargets();
  const rows = detectAll(targetTable, context.cwd);
  const tools = rows.filter((item) => !item.target.shared);
  // The shared folder last: it is not a coding agent, and is always installed into when asked.
  const ordered = [...tools, ...rows.filter((item) => item.target.shared)];

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        targets: ordered.map((item) => ({
          name: item.target.name,
          aliases: item.target.aliases,
          displayName: item.target.displayName,
          kind: item.target.kind,
          shared: item.target.shared,
          detected: item.detected,
          by: item.by,
          origin: item.target.origin,
        })),
        skipped: loadTargetFiles().skipped,
      },
    });
    return;
  }

  // A target this machine lacks is noise, but one your own file defines stays in view.
  const shown = all
    ? tools
    : tools.filter((item) => item.detected || item.target.origin !== BUILT_IN);
  if (shown.length > 0) {
    printTargets(context, shown);
    context.printer.info();
  }
  context.printer.info(foundSummary(tools.filter((item) => item.detected).length, tools.length));
  if (shown.length < tools.length) {
    context.printer.hint("Run `aireg targets --all` to see every one.");
  }
  for (const { target } of rows.filter((item) => item.target.shared)) {
    context.printer.hint(sharedHint(target));
  }
  warnSkipped(context);
}

/** A shared folder has no row, so its ids are said once below the table. */
function sharedHint(target: Target): string {
  const aliases = target.aliases.map((alias) => `\`${alias}\``);
  const also = aliases.length === 0 ? "" : `, or ${listed(aliases, "or")},`;
  return `Use \`--for ${target.name}\`${also} for the shared ${target.projectRoot} folder.`;
}

/** One row per coding agent; the shared folder is not a tool, so it has no row. */
function printTargets(context: CommandContext, rows: readonly Detection[]): void {
  const { style } = context.printer;
  const fromFiles = rows.some((item) => item.target.origin !== BUILT_IN);
  table(
    context.printer,
    [
      { header: "target", value: (item: Detection) => item.target.displayName },
      { header: "id", value: (item: Detection) => style.dim(item.target.name) },
      { header: "aliases", value: (item: Detection) => style.dim(item.target.aliases.join(", ")) },
      {
        header: "status",
        value: (item: Detection) => (item.detected ? style.green("found") : style.dim("not found")),
      },
      {
        header: "where",
        value: (item: Detection) => style.dim(item.detected ? foundBy(item.by) : ""),
      },
      // Only once a file of yours defines one: with the built-ins alone it says nothing.
      ...(fromFiles
        ? [{ header: "from", value: (item: Detection) => style.dim(origin(item.target.origin)) }]
        : []),
    ],
    rows,
  );
}

export function foundSummary(found: number, supported: number): string {
  if (found === 0) return "No supported target found on this machine.";
  const which = found === supported ? `all ${supported}` : `${found} of ${supported}`;
  return `Found ${which} supported targets on this machine.`;
}

/** The definition as aireg resolved it, after its defaults and your files. */
async function show(context: CommandContext, id: string): Promise<void> {
  const targetTable = resolveTargets();
  const target = targetTable[canonicalId(targetTable, id)];
  if (target === undefined) {
    throw new AiregError(`No target named ${quoted(id)}.`, {
      code: ErrorCode.Usage,
      hint: "Run `aireg targets` to see every target and its id.",
    });
  }
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { target } });
    return;
  }
  const { name, displayName, origin: from, ...rest } = target;
  context.printer.info(`${displayName} (${name}), ${origin(from)}`);
  context.printer.info(stringify(rest, { lineWidth: 0 }).trimEnd());
}

/** A file checked as aireg would read it from your user scope, wherever it is now. */
async function check(context: CommandContext, file: string): Promise<void> {
  const path = resolve(context.cwd, file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new AiregError(`Could not read ${file}.`, { code: ErrorCode.Usage, cause });
  }
  const result = checkTargetText(path, text);
  const problems = "problems" in result ? result.problems : [];
  if (problems.length > 0) context.exit = ExitCode.Error;
  if (context.printer.format === "json") {
    const id = "definition" in result ? result.definition.id : undefined;
    context.printer.json({ ok: problems.length === 0, data: { path, id, problems } });
    return;
  }
  if ("definition" in result) {
    const { id } = result.definition;
    const builtIn = BUILTIN_TARGETS.some((each) => each.id === id);
    context.printer.success(
      `${file} defines the target ${quoted(id)}${builtIn ? `, in place of the built-in one` : ""}.`,
    );
    const home = join(targetsDir(), `${id}.json`);
    if (home !== path) context.printer.hint(`Save it as ${underHome(home)} for aireg to use it.`);
    return;
  }
  for (const problem of problems) context.printer.error(problem);
  context.printer.info(`Found ${plural(problems.length, "problem")} in ${file}.`);
}
