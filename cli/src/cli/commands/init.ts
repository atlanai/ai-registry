import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { isAdapterError } from "#adapter/index.ts";
import { KINDS } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import { list, plural, quoted } from "#adapter/text.ts";
import type { InitNext, InitResult, InitSteps } from "#cli/commands/init/result.ts";
import { INIT_COMMAND } from "#cli/commands/init/spec.ts";
import type { Step } from "#cli/onboarding/flow.ts";
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
import { assertManagedPath } from "#core/store/managed-paths.ts";
import { roots as makeRoots, userScopeDir } from "#core/store/paths.ts";
import { canonicalIds, IMPORTABLE_TARGETS } from "#core/target/ids.ts";
import { placementFor } from "#core/target/placement.ts";
import { resolveTargets } from "#core/target/table.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { selectTargets } from "#engine/install/targets.ts";
import type { CommonOptions } from "#engine/options.ts";
import { defineCommand } from "./define.ts";

interface Own extends Record<string, unknown> {
  import?: string;
  registry?: string;
  as?: string;
  adapter?: string;
  "publish-to"?: string;
  "token-stdin"?: boolean;
  watch?: boolean;
}

interface Options {
  own: Own;
  common: CommonOptions;
}

interface Shown {
  shown: string;
  folders: string[];
  resumed: boolean;
  /** Asked of git only for text, which warns when it is true. */
  ignored: boolean;
}

type Done = (InitNext | InitSteps) & Shown;

const NEXT = ["aireg registry add <address> --as <name>", "aireg add <name>/<namespace>"] as const;

export const { run } = defineCommand({
  spec: INIT_COMMAND,
  parse(argv): Options {
    // Not an init option, but the reason is worth more than "Unknown option".
    if (argv.some((arg) => arg === USER.flag || arg === USER.short)) {
      throw new AiregError("Your user scope needs no setup.", {
        code: ErrorCode.Usage,
        hint: "Install into it with `aireg add -g`.",
      });
    }
    const { positionals, common, own } = parse<Own>(argv, INIT_COMMAND);
    noArguments(positionals, "init", "Run `aireg init` inside the project folder.");
    return { own, common };
  },
  async run({ own, common }, context): Promise<Done> {
    const scope = "project";
    const roots = makeRoots(scope, context.cwd);
    if (canonical(dirname(roots.manifest)) === userScopeDir()) {
      throw new AiregError(
        "The .registry/ in your home folder is your user scope, not a project.",
        {
          code: ErrorCode.Usage,
          hint: "Run `aireg init` inside a project, or install for yourself with `aireg add -g <registry>`.",
        },
      );
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
    const chosen = selectTargets(emptyManifest(), resolveTargets(process.env), common);

    const imports = requestedImports(own.import);
    const namespace = publishTarget(own["publish-to"]);
    const planned =
      imports.length === 0 ? undefined : await planImport(context.cwd, imports, scope);

    // An account resolves its address through this file, so replacing it must
    // carry every declaration forward or every account is left dangling.
    const existing = await readManifest(roots.manifest);
    // Settled before anything is written, so a refused import leaves nothing behind.
    const source = own.registry;
    const into =
      source !== undefined || planned === undefined ? undefined : importInto(existing.registries);

    // The manifest and the ignore file below go in the scope folder, which must be this project's.
    await assertManagedPath(roots.manifest, roots, { env: process.env });
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
    const written = { manifest: roots.manifest, scope, targets: chosen, imported } as const;
    const shown = {
      shown: shownFrom(context.cwd, roots.manifest),
      folders: chosen.length === 0 ? [] : foldersFor(chosen),
      resumed: resuming,
      ignored: context.printer.format !== "json" && (await gitIgnores(roots.manifest)),
    };

    // With a registry named, `init` is the whole setup, and the import runs
    // inside that chain so it happens after the pull.
    if (source === undefined) return { ...written, next: [...NEXT], ...shown };
    // What was written is said before the steps, which take a while and may fail.
    printWritten(context.printer, written, shown);
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
    return { ...written, steps, ...shown };
  },
  text(result, printer) {
    if (!("steps" in result)) {
      printWritten(printer, result, result);
      printer.note("next", NEXT[0]);
      printer.note("", NEXT[1]);
      return;
    }
    printer.info("");
    table(
      printer,
      [
        { header: "", value: (step: Step) => step.name },
        { header: "", value: (step: Step) => printer.style.dim(step.detail) },
      ],
      result.steps,
      { header: false },
    );
  },
  data(result): InitResult {
    const { manifest, scope, targets, imported } = result;
    return "steps" in result
      ? { manifest, scope, targets, imported, steps: result.steps }
      : { manifest, scope, targets, imported, next: result.next };
  },
});

function requestedImports(value: string | undefined): string[] {
  if (value === undefined) return [];
  const requested =
    value === "all"
      ? [...IMPORTABLE_TARGETS]
      : canonicalIds(resolveTargets(process.env), value.split(","));
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

function printWritten(
  printer: Printer,
  written: { targets: readonly string[]; imported: number },
  { shown, folders, resumed, ignored }: Shown,
): void {
  printer.success(resumed ? `Resumed setup from ${shown}.` : `Wrote ${shown}.`);
  if (written.imported > 0) {
    printer.info(`Imported ${plural(written.imported, "artifact")} into .registry.`);
  }
  printer.info(
    written.targets.length === 0
      ? "No target was detected, so edit `targets:` in the manifest before you sync."
      : `Installs for ${list(written.targets)}, into ${list(folders)}.`,
  );
  // Teammates would clone a project that installs nothing.
  if (!ignored) return;
  printer.warning(
    "git ignores .registry/manifest.yml, so teammates will not get what this project installs.",
  );
  printer.hint(
    "Take .registry/ out of your .gitignore. To skip committing installed copies, uncomment `artifacts/` in .registry/.gitignore.",
  );
}

function shownFrom(cwd: string, manifest: string): string {
  const shown = relative(cwd, manifest);
  return shown !== "" && isWithin(cwd, manifest) ? shown : manifest;
}

/** A shared folder such as `.agents` stands in for every target that reads it. */
function foldersFor(chosen: readonly string[]): string[] {
  const targetTable = resolveTargets(process.env);
  const where = { scope: "project", env: process.env } as const;
  const placed = new Set(
    KINDS.flatMap((kind) => placementFor(kind, chosen, { targetTable, where }).targets),
  );
  return [...placed].sort().map((name) => targetTable[name]?.projectRoot ?? name);
}

/** False outside a repository or without git, where there is nothing to warn about. */
async function gitIgnores(path: string): Promise<boolean> {
  return (await gitIn(dirname(path), ["check-ignore", "-q", "--", path])).code === 0;
}

/** A registry that is not there leaves the project set up, and a rerun picks up from it. */
function carryOn(error: unknown, alias: string | undefined): unknown {
  let adapter = isAdapterError(error) ? error : undefined;
  if (adapter === undefined && error instanceof Error && isAdapterError(error.cause)) {
    adapter = error.cause;
  }
  if (adapter?.failure !== "not_found" || adapter.hint !== undefined) return error;
  const as = alias === undefined ? "" : ` --as ${alias}`;
  return new AiregError(adapter.message, {
    code: ErrorCode.NotFound,
    hint: `Correct the address and run \`aireg init --registry <registry>${as}\` again; the project is already set up.`,
    cause: adapter,
  });
}
