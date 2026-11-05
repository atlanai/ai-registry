import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { list, quoted, sanitizeBlock, sanitizeName } from "#adapter/text.ts";
import type { ShowResult } from "#cli/commands/show/result.ts";
import { SHOW_COMMAND } from "#cli/commands/show/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { expandUserPath, isMissing } from "#core/fs/path.ts";
import { isDirectory } from "#core/fs/tree.ts";
import { AGENT_ENTRY } from "#core/kinds.ts";
import { type Carried, carries, describeCarried } from "#core/plan/carries.ts";
import { parseRef } from "#core/ref.ts";
import type { Printer } from "#core/term/printer.ts";
import {
  atAddress,
  probeAddress,
  type SourceFlags,
  throughManifest,
  throughRegistry,
  wantOf,
} from "#engine/address/probe.ts";
import { knownRegistries, undeclaredRegistry } from "#engine/address/registries.ts";
import type { CommonOptions } from "#engine/options.ts";
import { defineCommand } from "./define.ts";

interface Options {
  input: string;
  registry: string | undefined;
  flags: SourceFlags;
  common: CommonOptions;
}

interface Shown {
  data: ShowResult;
  name: string;
}

/** Prints an artifact to pipe into an agent; nothing is installed, linked or written. */
export const { run } = defineCommand({
  spec: SHOW_COMMAND,
  parse(argv): Options {
    const { positionals, common, own } = parse<SourceFlags & { registry?: string }>(
      argv,
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
    return { input, registry: own.registry, flags: own, common };
  },
  async run({ input, registry, flags, common }, context): Promise<Shown> {
    if (registry === undefined && /^(\.{1,2}(\/|$)|\/|~\/)/.test(input)) {
      return showFolder(context.cwd, input);
    }

    const known = await knownRegistries(common, context.cwd);
    const resolved =
      registry === undefined
        ? throughManifest(input, known, flags)
        : throughRegistry(registry, input, known, flags);
    // A name with no host is a registry's name, so an undeclared one is reported as that.
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
      // The catalog was narrowed to `wanted`, so on a miss it is empty;
      // naming what is available needs the unnarrowed listing.
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
    const body =
      file === undefined ? undefined : await readFile(file, "utf8").catch(() => undefined);
    if (body === undefined) {
      throw new AiregError(`Cannot read ${entry.path}.`, {
        code: ErrorCode.Invalid,
        hint: "The registry serves this artifact without a Markdown file to print.",
      });
    }
    const version = source.versionOf(entry);
    return {
      data: {
        name: entry.name,
        kind: entry.kind,
        ...(version === undefined ? {} : { version }),
        body,
        carries: await carries(path),
      },
      name: entry.name,
    };
  },
  data: (result) => result.data,
  text({ data, name }, printer) {
    print(printer, data.body);
    disclose(printer, name, data.carries);
  },
});

async function showFolder(cwd: string, input: string): Promise<Shown> {
  const path = resolve(cwd, expandUserPath(input));
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
  return { data: { path: file, body, carries: await carries(path) }, name: basename(path) };
}

/** A folder's own Markdown: its SKILL.md, AGENT.md or README.md, else its first Markdown file. */
async function markdownIn(dir: string): Promise<string | undefined> {
  const names = (await readdir(dir)).sort();
  const own =
    [SKILL_ENTRY, AGENT_ENTRY, "README.md"].find((name) => names.includes(name)) ??
    names.find((name) => name.endsWith(".md"));
  return own === undefined ? undefined : join(dir, own);
}

/** What a registry serves can hide lines from the reader, or write to their clipboard. */
function print(printer: Printer, body: string): void {
  const safe = sanitizeBlock(body);
  printer.info(safe.trimEnd());
  if (safe !== body) {
    printer.warning(
      "Removed terminal control characters from the output; `--json` prints the file as written.",
    );
  }
}

/** On stderr, so the body still pipes into an agent unchanged. */
function disclose(printer: Printer, name: string, carried: readonly Carried[]): void {
  if (carried.length === 0) return;
  printer.warning(
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
