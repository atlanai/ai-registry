import { list, quoted } from "#adapter/text.ts";
import { type ActionSpec, allCommands, type CommandSpec, warnHidden } from "#cli/commands/index.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import type { Printer } from "#core/output.ts";
import { DOCS_URL, NAME } from "#core/product.ts";
import pkg from "#package.json" with { type: "json" };
import { GLOBAL_OPTIONS, MAP_FORMATS, type MapFormat } from "./options.ts";

/** A node in the `--map` tree: a command, an action, or the root. */
export interface MapNode {
  readonly path: string;
  readonly summary?: string;
  readonly group?: string;
  readonly aliases?: readonly string[];
  readonly usage?: readonly string[];
  readonly options?: readonly OptionSpec[];
  readonly docs?: string;
  readonly children?: readonly MapNode[];
}

function isMapFormat(value: string): value is MapFormat {
  return (MAP_FORMATS as readonly string[]).includes(value);
}

const ROOT_PATH = NAME;
export const ROOT_USAGE: readonly string[] = [
  "aireg <command> [options]",
  "aireg help <command> [<action>]",
];
/** What aireg is, in the one line `--help`, the bare command and `--map` open with. */
export const ROOT_SUMMARY = "Install agent artifacts from any registry into any coding agent.";

export const ISSUES_URL = pkg.bugs.url;

export function docsUrl(page = "index"): string {
  if (/^https?:\/\//.test(page)) return page;
  return `${DOCS_URL}reference/${page === "index" ? "" : `${page}/`}`;
}

/** `usage` and `options` only when there are some, so a key's presence means something. */
function described(of: CommandSpec | ActionSpec) {
  const options = of.options ?? [];
  return {
    ...(of.usage === undefined ? {} : { usage: of.usage }),
    ...(options.length === 0 ? {} : { options }),
  };
}

export function actionNode(command: CommandSpec, action: ActionSpec): MapNode {
  return {
    path: `${ROOT_PATH} ${command.name} ${action.name}`,
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    ...(action.aliases === undefined ? {} : { aliases: action.aliases }),
    ...described(action),
  };
}

export function commandNode(command: CommandSpec): MapNode {
  const path = `${ROOT_PATH} ${command.name}`;
  return {
    path,
    summary: command.summary,
    group: command.group,
    ...(command.aliases !== undefined && command.aliases.length > 0
      ? { aliases: [...command.aliases] }
      : {}),
    ...described(command),
    docs: docsUrl(command.docs),
    ...(command.actions !== undefined && command.actions.length > 0
      ? { children: command.actions.map((action) => actionNode(command, action)) }
      : {}),
  };
}

/** The whole command tree, built-in and adapter-contributed alike. */
export async function buildMap(): Promise<MapNode> {
  const commands = await allCommands();
  return {
    path: ROOT_PATH,
    summary: ROOT_SUMMARY,
    usage: ROOT_USAGE,
    options: GLOBAL_OPTIONS,
    children: commands.map(commandNode),
  };
}

/** Tree text omits usage and options; they stay a JSON-only affordance. */
function writeTree(node: MapNode, indent: string, lines: string[]): void {
  const head =
    node.summary === undefined ? `${indent}${node.path}` : `${indent}${node.path}\t${node.summary}`;
  lines.push(head);
  for (const child of node.children ?? []) writeTree(child, `${indent}  `, lines);
}

function writeCompact(node: MapNode, lines: string[]): void {
  lines.push(node.path);
  for (const child of node.children ?? []) writeCompact(child, lines);
}

const MAP_FLAG = "--map";

/**
 * Only a known format is swallowed, so `aireg --map add` keeps `add` a
 * positional rather than an unknown-format error.
 */
export function mapTakesValue(next: string | undefined): boolean {
  return next !== undefined && isMapFormat(next);
}

/**
 * Bare `--map` means tree. The `=` form is unambiguous, so an unknown format
 * there is an error rather than a silent default.
 */
export function findMapFormat(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith(`${MAP_FLAG}=`)) return arg.slice(MAP_FLAG.length + 1);
    if (arg === MAP_FLAG) return mapTakesValue(argv[i + 1]) ? (argv[i + 1] as string) : "tree";
  }
  return undefined;
}

/**
 * Runs instead of any command: exists so a coding agent gets the whole tree
 * in one call, instead of paying a `--help` round trip per level.
 */
export async function runMap(printer: Printer, format: string): Promise<ExitCode> {
  if (!isMapFormat(format)) {
    throw new AiregError(`Unknown --map format ${quoted(format)}.`, {
      code: ErrorCode.Usage,
      hint: `Use ${list(MAP_FORMATS, "or")}.`,
    });
  }
  await warnHidden(printer);
  const root = await buildMap();
  if (printer.format === "json") {
    printer.json({ ok: true, data: root });
    return ExitCode.Ok;
  }
  if (format === "json") {
    printer.info(JSON.stringify(root, null, 2));
    return ExitCode.Ok;
  }
  const lines: string[] = [];
  if (format === "tree") writeTree(root, "", lines);
  else writeCompact(root, lines);
  printer.info(lines.join("\n"));
  return ExitCode.Ok;
}
