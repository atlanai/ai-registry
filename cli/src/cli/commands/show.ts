import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { list, quoted, sanitizeBlock, sanitizeName } from "#adapter/text.ts";
import { SHOW_COMMAND } from "#cli/commands/show/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { expandUserPath, isMissing } from "#core/fs/path.ts";
import { isDirectory } from "#core/fs/tree.ts";
import { AGENT_ENTRY } from "#core/kinds.ts";
import { type Carried, carries, describeCarried } from "#core/plan/carries.ts";
import { parseRef } from "#core/ref.ts";
import {
  atAddress,
  probeAddress,
  type SourceFlags,
  throughManifest,
  throughRegistry,
  wantOf,
} from "#engine/address/probe.ts";
import { knownRegistries, undeclaredRegistry } from "#engine/address/registries.ts";
import type { CommandContext } from "./command.ts";

/**
 * Prints an artifact so it can be piped straight into an agent. Nothing is
 * installed, nothing is linked, and no manifest is written.
 */
export async function run(context: CommandContext): Promise<void> {
  const { positionals, common, own } = parse<SourceFlags & { registry?: string }>(
    context.argv,
    SHOW_COMMAND,
  );
  const input = positionals[0];
  if (input === undefined) {
    throw needsInput(
      "show",
      "an artifact address",
      "Name one: `aireg show <registry>/<namespace>/<name>`, or `aireg show <namespace>/<name> --registry <registry>`.",
    );
  }

  const registry = own.registry;
  if (registry === undefined && /^(\.{1,2}(\/|$)|\/|~\/)/.test(input)) {
    return showFolder(context, input);
  }

  const known = await knownRegistries(common, context.cwd);
  const resolved =
    registry === undefined
      ? throughManifest(input, known, own)
      : throughRegistry(registry, input, known, own);
  // A name with no host is a registry's name, so one this scope does not declare is said as that.
  if (registry === undefined && !resolved.declared) {
    const unknown = await undeclaredRegistry(input, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }
  const wanted = resolved.name;
  if (wanted === undefined) {
    const what =
      registry !== undefined || namesNamespace(input, resolved.declared)
        ? "a namespace"
        : "a registry";
    throw new AiregError(`${quoted(input)} names ${what}, not an artifact.`, {
      code: ErrorCode.Usage,
      hint: `Add an artifact's name; run \`aireg registry show ${resolved.alias ?? registry ?? input}\` to see them.`,
    });
  }

  const source = await probeAddress(resolved, context.cwd, wantOf(resolved));
  const catalog = source.catalog;
  const pool = atAddress(resolved, catalog.entries, resolved.alias ?? source.alias);
  const entry = pool.find((item) => item.name === sanitizeName(wanted));

  if (entry === undefined) {
    // The catalog was narrowed to `wanted`, so on a miss it is empty: naming what
    // is available needs the unnarrowed listing `aireg registry show` already does.
    const names = catalog.entries.map((item) => item.name);
    throw new AiregError(`No artifact named ${quoted(wanted)}.`, {
      code: ErrorCode.NotFound,
      hint:
        names.length === 0
          ? `Run \`aireg registry show ${registry ?? input.split("/")[0]}\` to see what it publishes.`
          : `Use ${list(names, "or")}.`,
    });
  }

  const path = await source.content(entry);
  const file = (await isDirectory(path)) ? await markdownIn(path) : path;
  const body = file === undefined ? undefined : await readFile(file, "utf8").catch(() => undefined);
  if (body === undefined) {
    throw new AiregError(`Cannot read ${entry.path}.`, {
      code: ErrorCode.Invalid,
      hint: "The registry serves this artifact without a Markdown file to print.",
    });
  }
  const carried = await carries(path);

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        name: entry.name,
        kind: entry.kind,
        version: source.versionOf(entry),
        body,
        carries: carried,
      },
    });
    return;
  }
  print(context, body);
  disclose(context, entry.name, carried);
}

/** A folder or file on disk, printed the way an agent reads it: its own Markdown. */
async function showFolder(context: CommandContext, input: string): Promise<void> {
  const path = resolve(context.cwd, expandUserPath(input));
  const file = (await isDirectory(path)) ? await markdownIn(path) : path;
  if (file === undefined)
    throw new AiregError(`${input} holds no Markdown to read.`, { code: ErrorCode.Invalid });
  const body = await readFile(file, "utf8").catch((error: unknown) => {
    if (isMissing(error))
      throw new AiregError(`${input} does not exist.`, { code: ErrorCode.NotFound });
    return undefined;
  });
  if (body === undefined) {
    throw new AiregError(`Cannot read ${input}.`, {
      code: ErrorCode.Invalid,
      hint: "Check that it is a readable file or folder.",
    });
  }
  const carried = await carries(path);
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { path: file, body, carries: carried } });
    return;
  }
  print(context, body);
  disclose(context, basename(path), carried);
}

/** A folder's own Markdown: its SKILL.md, AGENT.md or README.md, else its first Markdown file. */
async function markdownIn(dir: string): Promise<string | undefined> {
  const names = (await readdir(dir)).sort();
  const own =
    [SKILL_ENTRY, AGENT_ENTRY, "README.md"].find((name) => names.includes(name)) ??
    names.find((name) => name.endsWith(".md"));
  return own === undefined ? undefined : join(dir, own);
}

/** What a registry serves can hide lines from the person reading it, or write to their clipboard. */
function print(context: CommandContext, body: string): void {
  const safe = sanitizeBlock(body);
  context.printer.info(safe.trimEnd());
  if (safe !== body) {
    context.printer.warning(
      "Removed terminal control characters from the output; `--json` prints the file as written.",
    );
  }
}

/** Said apart from the body, on stderr, so the body still pipes into an agent unchanged. */
function disclose(context: CommandContext, name: string, carried: readonly Carried[]): void {
  if (carried.length === 0) return;
  context.printer.warning(
    `${name} carries ${describeCarried(carried)}, which a target that loads it runs as you.`,
  );
}

/** A declared address that goes past its registry names a namespace; a source is a registry. */
function namesNamespace(input: string, declared: boolean): boolean {
  if (!declared) return false;
  try {
    return parseRef(input).namespace !== undefined;
  } catch {
    return false;
  }
}
