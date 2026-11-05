import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { list as listed, plural, quoted } from "#adapter/text.ts";
import { foundBy } from "#cli/commands/targets/render.ts";
import type { TargetCheck, TargetShown, TargetsList } from "#cli/commands/targets/result.ts";
import { TARGETS_COMMAND } from "#cli/commands/targets/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { unknownAction } from "#cli/options/suggest.ts";
import { underHome } from "#cli/render/home.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { targetsDir } from "#core/store/paths.ts";
import type { EarlierTarget, Target, Targets } from "#core/target/contract.ts";
import { type Detection, detectAll } from "#core/target/detect.ts";
import { canonicalId, earlierId, earlierTable } from "#core/target/ids.ts";
import {
  BUILT_IN,
  checkTargetText,
  loadTargetFiles,
  type SkippedFile,
  type TargetFile,
} from "#core/target/load.ts";
import { resolveTargets } from "#core/target/table.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { action, defineCommand } from "./define.ts";

interface Options {
  all: boolean;
  argument: string | undefined;
}

interface Listing {
  targetTable: Targets;
  rows: Detection[];
  files: TargetFile[];
  skipped: SkippedFile[];
}

interface Checked {
  file: string;
  path: string;
  result: TargetFile | SkippedFile;
}

/** The listing has no action word, so its key is one a typed word must not reach. */
const LISTING = "targets";

export const { run } = defineCommand<Options>({
  spec: TARGETS_COMMAND,
  parse(argv) {
    const { positionals, common } = parse(argv, TARGETS_COMMAND);
    const [verb, argument] = positionals;
    if (verb === LISTING) {
      const names = (TARGETS_COMMAND.actions ?? []).map((each) => each.name);
      throw unknownAction(TARGETS_COMMAND.name, verb, names, `Use ${listed(names, "or")}.`);
    }
    return { action: verb ?? LISTING, options: { all: common.all, argument } };
  },
  actions: {
    [LISTING]: action({
      run: async (_options, context): Promise<Listing> => {
        // Every name `--for` takes; a shared folder such as `.agents` is never detected.
        const targetTable = resolveTargets();
        const detected = detectAll(targetTable, context.cwd);
        // Shared folders last: not a coding agent, and always installed into when asked.
        const rows = [
          ...detected.filter((item) => !item.target.shared),
          ...detected.filter((item) => item.target.shared),
        ];
        return { targetTable, rows, ...loadTargetFiles() };
      },
      data: ({ targetTable, rows, files, skipped }): TargetsList => ({
        targets: rows.map((item) => ({
          name: item.target.name,
          aliases: item.target.aliases,
          displayName: item.target.displayName,
          shared: item.target.shared,
          detected: item.detected,
          ...(item.by === undefined ? {} : { by: item.by }),
          origin: item.target.origin,
        })),
        harnesses: earlierRows(targetTable, rows),
        skipped,
        warnings: files
          .filter((file) => file.warnings.length > 0)
          .map(({ path, warnings }) => ({ path, warnings })),
      }),
      text: (found, printer, { all }) => printListing(printer, found, all),
    }),
    show: action({
      run: async ({ argument }): Promise<TargetShown> => {
        const id = needed(argument, "show", "a target id", "Run `aireg targets` to see every id.");
        return show(id);
      },
      text: ({ target }, printer) => {
        const { name, displayName, origin: from, ...rest } = target;
        printer.info(`${displayName} (${name}), ${origin(from)}`);
        printer.info(stringify(rest, { lineWidth: 0 }).trimEnd());
      },
    }),
    check: action({
      run: async ({ argument }, context): Promise<Checked> => {
        const file = needed(
          argument,
          "check",
          "a file",
          "Name the file to check: `aireg targets check <file>`.",
        );
        const checked = await check(context.cwd, file);
        if ("problems" in checked.result) context.exit = ExitCode.Error;
        return checked;
      },
      data: ({ path, result }): TargetCheck => ({
        path,
        ...("definition" in result ? { id: result.definition.id } : {}),
        problems: "problems" in result ? result.problems : [],
        warnings: "warnings" in result ? result.warnings : [],
      }),
      ok: ({ result }) => !("problems" in result),
      text: ({ file, path, result }, printer) => printCheck(printer, file, path, result),
    }),
  },
});

/** The rows as aireg 0.1 printed them, under `harnesses`, for scripts written against it. */
function earlierRows(targetTable: Targets, rows: readonly Detection[]) {
  const earlier = earlierTable(targetTable);
  return rows.map((item) => {
    const was = earlier[earlierId(targetTable, item.target.name)] as EarlierTarget;
    return {
      name: was.name,
      displayName: was.displayName,
      kind: was.kind,
      shared: was.shared,
      detected: item.detected,
      ...(item.by === undefined ? {} : { by: item.by }),
      origin: was.origin,
    };
  });
}

/** A target this machine lacks is noise, but one your own file defines stays in view. */
function printListing(printer: Printer, found: Listing, all: boolean): void {
  const tools = found.rows.filter((item) => !item.target.shared);
  const shown = all
    ? tools
    : tools.filter((item) => item.detected || item.target.origin !== BUILT_IN);
  if (shown.length > 0) {
    printTargets(printer, shown);
    printer.info();
  }
  printer.info(foundSummary(tools.filter((item) => item.detected).length, tools.length));
  if (shown.length < tools.length) {
    printer.hint("Run `aireg targets --all` to see every one.");
  }
  // A profile is a folder of its definition's, so the definition's hint covers it.
  for (const { target } of found.rows.filter(
    (item) => item.target.shared && !item.target.name.includes(":"),
  )) {
    printer.hint(sharedHint(target));
  }
  warnFiles(printer, found.files, found.skipped);
}

function printTargets(printer: Printer, rows: readonly Detection[]): void {
  const { style } = printer;
  const fromFiles = rows.some((item) => item.target.origin !== BUILT_IN);
  table(
    printer,
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
      ...(fromFiles
        ? [{ header: "from", value: (item: Detection) => style.dim(origin(item.target.origin)) }]
        : []),
    ],
    rows,
  );
}

function origin(path: string): string {
  return path === BUILT_IN ? "built in" : underHome(path);
}

/** A shared folder has no row, so its ids are said once below the table. */
function sharedHint(target: Target): string {
  const aliases = target.aliases.map((alias) => `\`${alias}\``);
  const also = aliases.length === 0 ? "" : `, or ${listed(aliases, "or")},`;
  return `Use \`--for ${target.name}\`${also} for the shared ${target.projectRoot} folder.`;
}

const lowered = (sentences: readonly string[]) => {
  const text = sentences.join(" ");
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
};

/** Files in your user scope aireg could not use, or uses but would have you change. */
function warnFiles(
  printer: Printer,
  files: readonly TargetFile[],
  skipped: readonly SkippedFile[],
): void {
  for (const file of skipped) {
    printer.warning(`Skipped ${underHome(file.path)}: ${lowered(file.problems)}`);
  }
  for (const file of files.filter((each) => each.warnings.length > 0)) {
    printer.warning(`Read ${underHome(file.path)}, but ${lowered(file.warnings)}`);
  }
}

function needed(argument: string | undefined, verb: string, what: string, hint: string): string {
  if (argument !== undefined) return argument;
  throw needsInput(`targets ${verb}`, what, hint);
}

function show(id: string): TargetShown {
  const targetTable = resolveTargets();
  const target = targetTable[canonicalId(targetTable, id)];
  if (target === undefined) {
    throw new AiregError(`No target named ${quoted(id)}.`, {
      code: ErrorCode.Usage,
      hint: "Run `aireg targets` to see every target and its id.",
    });
  }
  // `category` is internal; `shared` already says what a person needs of it.
  const { category: _, ...shown } = target;
  const earlier = earlierTable(targetTable)[earlierId(targetTable, target.name)];
  const { category: _category, aliases: _aliases, ...harness } = earlier as EarlierTarget;
  return { target: shown, harness };
}

/** A file checked as aireg would read it from your user scope, wherever it is now. */
async function check(cwd: string, file: string): Promise<Checked> {
  const path = resolve(cwd, file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new AiregError(`Could not read ${file}.`, { code: ErrorCode.Usage, cause });
  }
  return { file, path, result: checkTargetText(path, text) };
}

function printCheck(
  printer: Printer,
  file: string,
  path: string,
  result: TargetFile | SkippedFile,
): void {
  if ("definition" in result) {
    const { id } = result.definition;
    const builtIn = BUILTIN_TARGETS.some((each) => each.id === id);
    printer.success(
      `${file} defines the target ${quoted(id)}${builtIn ? `, in place of the built-in one` : ""}.`,
    );
    for (const warning of result.warnings) printer.warning(warning);
    const home = join(targetsDir(), `${id}.json`);
    if (home !== path) printer.hint(`Save it as ${underHome(home)} for aireg to use it.`);
    return;
  }
  for (const problem of result.problems) printer.error(problem);
  printer.info(`Found ${plural(result.problems.length, "problem")} in ${file}.`);
}

export function foundSummary(found: number, supported: number): string {
  if (found === 0) return "No supported target found on this machine.";
  const which = found === supported ? `all ${supported}` : `${found} of ${supported}`;
  return `Found ${which} supported targets on this machine.`;
}
