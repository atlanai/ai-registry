import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { isAdapterError } from "#adapter/index.ts";
import { KINDS } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import { list, plural, quoted } from "#adapter/text.ts";
import { INIT_COMMAND } from "#cli/commands/init/spec.ts";
import { applyImport, planImport } from "#cli/onboarding/import.ts";
import { USER } from "#cli/options/flags.ts";
import { noArguments, parse } from "#cli/options/parse.ts";
import { isNamespaceAddress } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/realpath.ts";
import { formatManifest } from "#core/manifest/format.ts";
import { emptyManifest } from "#core/manifest/model.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { gitIn } from "#core/process.ts";
import { ensureScopeIgnore } from "#core/store/ignore.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import { roots as makeRoots, userScopeDir } from "#core/store/paths.ts";
import { canonicalIds, IMPORTABLE_TARGETS } from "#core/target/ids.ts";
import { placementFor } from "#core/target/placement.ts";
import { resolveTargets } from "#core/target/table.ts";
import { table } from "#core/term/table.ts";
import { selectTargets } from "#engine/install/targets.ts";
import type { CommandContext } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  // Not an init option, but the reason is worth more than "Unknown option".
  if (context.argv.some((arg) => arg === USER.flag || arg === USER.short)) {
    throw new AiregError("Your user scope needs no setup.", {
      code: ErrorCode.Usage,
      hint: "Install into it with `aireg add -g`.",
    });
  }
  const { positionals, common, own } = parse<Own>(context.argv, INIT_COMMAND);
  noArguments(positionals, "init", "Run `aireg init` inside the project folder.");
  const scope = "project";
  const roots = makeRoots(scope, context.cwd);
  if (canonical(dirname(roots.manifest)) === userScopeDir()) {
    throw new AiregError("The .registry/ in your home folder is your user scope, not a project.", {
      code: ErrorCode.Usage,
      hint: "Run `aireg init` inside a project, or install for yourself with `aireg add -g <registry>`.",
    });
  }

  // A manifest that installs nothing yet is where an `init --registry` that
  // stopped part way left off, so running it again carries on from there.
  const present = existsSync(roots.manifest) && !common.force;
  const resuming =
    present &&
    own.registry !== undefined &&
    (await readManifest(roots.manifest)).artifacts.length === 0;
  if (present && !resuming) {
    throw new AiregError(`${roots.manifest} already exists.`, {
      code: ErrorCode.Conflict,
      hint: "Pass `--force` to replace it.",
    });
  }

  // Detection is the default, not the rule: someone who names targets is saying
  // what this project projects into, and writing something else hides that.
  const chosen = selectTargets(emptyManifest(), resolveTargets(), common);

  const imports = requestedImports(own.import);
  const namespace = publishTarget(own["publish-to"]);
  const planned = imports.length === 0 ? undefined : await planImport(context.cwd, imports, scope);

  // An account resolves its address through this file, so replacing it must
  // carry every declaration forward or every account is left dangling.
  const existing = await readManifest(roots.manifest);
  // Settled before anything is written, so a refused import leaves nothing behind.
  const source = own.registry;
  const into =
    source !== undefined || planned === undefined ? undefined : importInto(existing.registries);

  // The manifest and the ignore file below go in the scope folder, which must be this project's.
  await guardManagedPath(roots.manifest, roots);
  if (!resuming) {
    const contents = formatManifest({
      ...emptyManifest(),
      targets: [...chosen],
      registries: existing.registries,
    });
    await mkdir(dirname(roots.manifest), { recursive: true });
    await writeFile(roots.manifest, contents, "utf8");
  }

  await ensureScopeIgnore(roots);
  const imported =
    planned === undefined || into === undefined ? 0 : await applyImport(planned, into);
  const json = context.printer.format === "json";
  const data = { manifest: roots.manifest, scope, targets: chosen, imported };
  if (!json) report(context, roots.manifest, chosen, imported, resuming);
  await warnIfIgnored(context, roots.manifest);

  // With a registry named, `init` is the whole setup, and the import runs
  // inside that chain so it happens after the pull.
  if (source === undefined) {
    if (json) context.printer.json({ ok: true, data: { ...data, next: NEXT } });
    else {
      context.printer.note("next", NEXT[0]);
      context.printer.note("", NEXT[1]);
    }
    return;
  }
  const { onboard } = await import("#cli/onboarding/flow.ts");
  const steps = await onboard(
    context,
    {
      registry: source,
      alias: own.as,
      adapter: own.adapter,
      namespace,
      tokenStdin: own["token-stdin"] === true,
      watch: own.watch === true,
    },
    imports,
    scope,
  ).catch((error: unknown) => {
    throw carryOn(error, own.as);
  });
  if (json) {
    context.printer.json({ ok: true, data: { ...data, steps } });
    return;
  }
  context.printer.info("");
  table(
    context.printer,
    [
      { header: "", value: (step: (typeof steps)[number]) => step.name },
      {
        header: "",
        value: (step: (typeof steps)[number]) => context.printer.style.dim(step.detail),
      },
    ],
    steps,
    { header: false },
  );
}

interface Own extends Record<string, unknown> {
  import?: string;
  registry?: string;
  as?: string;
  adapter?: string;
  "publish-to"?: string;
  "token-stdin"?: boolean;
  watch?: boolean;
}

function requestedImports(value: string | undefined): string[] {
  if (value === undefined) return [];
  const requested =
    value === "all" ? [...IMPORTABLE_TARGETS] : canonicalIds(resolveTargets(), value.split(","));
  const allowed = new Set<string>(IMPORTABLE_TARGETS);
  if (requested.length === 0 || requested.some((name) => !allowed.has(name))) {
    throw new AiregError(`Unknown --import value ${quoted(value)}.`, {
      code: ErrorCode.Usage,
      hint: `Pass ${list([...IMPORTABLE_TARGETS, "all"], "or")}.`,
    });
  }
  return [...new Set(requested)];
}

/** Checked with the other options, so a bad value leaves no manifest behind. */
function publishTarget(value: string | undefined): string | undefined {
  if (value === undefined || isNamespaceAddress(value)) return value;
  throw new AiregError(`--publish-to takes <registry>/<namespace>, not ${quoted(value)}.`, {
    code: ErrorCode.Usage,
    hint: "Name both parts, such as `--publish-to acme/engineering`.",
  });
}

/** Only ever one: an import is never fanned out to a registry nobody named. */
function importInto(declared: Readonly<Record<string, unknown>>): {
  registry: string;
  namespace: string;
} {
  const aliases = Object.keys(declared);
  const only = aliases[0];
  if (aliases.length !== 1 || only === undefined) {
    throw new AiregError(
      aliases.length === 0
        ? "Importing needs a registry to import into."
        : `Importing needs one registry, but ${list(aliases)} are declared.`,
      {
        code: ErrorCode.Usage,
        hint: "Pass `--registry <registry>`, or publish each one with `aireg publish <path> --to <registry>/<namespace>`.",
      },
    );
  }
  return { registry: only, namespace: only };
}

/** What `init` wrote, said as text; `--json` says it once, at the end. */
function report(
  context: CommandContext,
  manifest: string,
  chosen: readonly string[],
  imported: number,
  resumed = false,
): void {
  const shown = relative(context.cwd, manifest);
  const where = shown !== "" && isWithin(context.cwd, manifest) ? shown : manifest;
  context.printer.success(resumed ? `Resumed setup from ${where}.` : `Wrote ${where}.`);
  if (imported > 0)
    context.printer.info(`Imported ${plural(imported, "artifact")} into .registry.`);
  context.printer.info(
    chosen.length === 0
      ? "No target was detected, so edit `targets:` in the manifest before you sync."
      : `Installs for ${list(chosen)}, into ${list(foldersFor(chosen))}.`,
  );
}

/**
 * The project folders those targets read, which `aireg list` and `aireg status` name:
 * a shared one such as `.agents` stands in for every target that reads it.
 */
function foldersFor(chosen: readonly string[]): string[] {
  const targetTable = resolveTargets();
  const placed = new Set(
    KINDS.flatMap((kind) => placementFor(kind, chosen, targetTable, "project").targets),
  );
  return [...placed].sort().map((name) => targetTable[name]?.projectRoot ?? name);
}

const NEXT = ["aireg registry add <address> --as <name>", "aireg add <name>/<namespace>"] as const;

/** Teammates would clone a project that installs nothing. */
async function warnIfIgnored(context: CommandContext, manifest: string): Promise<void> {
  if (context.printer.format === "json" || !(await gitIgnores(manifest))) return;
  context.printer.warning(
    "git ignores .registry/manifest.yml, so teammates will not get what this project installs.",
  );
  context.printer.hint(
    "Take .registry/ out of your .gitignore. To skip committing installed copies, uncomment `artifacts/` in .registry/.gitignore.",
  );
}

/**
 * Whether git would leave `path` out of a commit. False outside a repository or
 * without git, where there is nothing to warn about.
 */
async function gitIgnores(path: string): Promise<boolean> {
  return (await gitIn(dirname(path), ["check-ignore", "-q", "--", path])).code === 0;
}

/** A registry that is not there leaves the project set up, and a rerun picks up from it. */
function carryOn(error: unknown, alias: string | undefined): unknown {
  const adapter = isAdapterError(error)
    ? error
    : error instanceof Error && isAdapterError(error.cause)
      ? error.cause
      : undefined;
  if (adapter?.failure !== "not_found" || adapter.hint !== undefined) return error;
  const as = alias === undefined ? "" : ` --as ${alias}`;
  return new AiregError(adapter.message, {
    code: ErrorCode.NotFound,
    hint: `Correct the address and run \`aireg init --registry <registry>${as}\` again; the project is already set up.`,
    cause: adapter,
  });
}
