import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { canSignIn } from "#adapter/contract.ts";
import { redirection } from "#adapter/files.ts";
import { readRegistry } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import {
  ENVELOPE,
  INDEX_DOCUMENT,
  isNamespace,
  REGISTRY_DOCUMENT,
  VERSIONS_DOCUMENT,
} from "#adapter/filespec/names.ts";
import { isAdapterError } from "#adapter/index.ts";
import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import {
  list as listOf,
  plural,
  quoted,
  sanitizeName,
  sanitizeText,
  withoutCredentials,
} from "#adapter/text.ts";
import { parseSource } from "#adapters/git/api.ts";
import { jobsClause, registryJobs, removeJobs } from "#cli/commands/registry/jobs.ts";
import { type Move, moveOf, recordMove, signInLeftBehind } from "#cli/commands/registry/move.ts";
import { parse } from "#cli/options.ts";
import { cancel, type Interaction, interaction, interactive } from "#cli/prompt/flow.ts";
import { canceled, defaultIo, text } from "#cli/prompt/index.ts";
import { commitAndPush, releaseSubject } from "#cli/publish/target.ts";
import { knownRegistries, undeclaredRegistry } from "#cli/registries.ts";
import { underHome } from "#cli/render/home.ts";
import { noteUserScope } from "#cli/render/where.ts";
import {
  type Probed,
  probe,
  type SourceFlags,
  sourceConfig,
  throughManifest,
} from "#cli/source.ts";
import { workflowCommand } from "#cli/workflow-command.ts";
import { expandLocation, recordedLocation } from "#core/adapter/location.ts";
import { loadAdapter } from "#core/adapter/registry.ts";
import type { Entry } from "#core/catalog/model.ts";
import { emptyRegistryConfig, type RegistryConfig } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { inGitHubActions, registryToken } from "#core/env.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { indexRoot } from "#core/filespec/write/indexer.ts";
import { findRegistry, requireRegistry, writeRoot } from "#core/filespec/write/init.ts";
import { kindsOf } from "#core/filespec/write/kinds.ts";
import { validateRoot } from "#core/filespec/write/validate.ts";
import { gitIn } from "#core/git.ts";
import type { Lock } from "#core/lock.ts";
import {
  type RegistrySource,
  reaches,
  readManifest,
  unknownRegistry,
  writeManifest,
} from "#core/manifest.ts";
import { abbreviate } from "#core/output.ts";
import { formatRef, type Ref } from "#core/ref.ts";
import { type Roots, scopeName } from "#core/store/paths.ts";
import { fields, table } from "#core/term/table.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load, withScope } from "#engine/pipeline.ts";
import {
  builtin,
  type CommandContext,
  type Hidden,
  hiddenKind,
  printHidden,
  RESERVED,
  runAction,
} from "./index.ts";

interface Flags extends SourceFlags {
  as?: string;
  name?: string;
  description?: string;
  namespace?: string[];
  base?: string;
}

/**
 * Declaring a registry and installing from it are separate steps, so a project
 * can name its sources up front and let `add` pick from them by alias.
 */
export async function run(context: CommandContext): Promise<void> {
  const spec = builtin("registry");
  const { positionals, common, own } = parse<Flags>(context.argv, spec);
  const [action = "list", argument] = positionals;
  return runAction(spec, action, {
    add: () => add(context, argument, own, common),
    init: () => init(context, argument, own, common),
    index: () => index(context, argument),
    validate: () => validate(context, argument, own.base),
    list: () => list(context, common),
    show: () => show(context, argument, own, common),
    remove: () => remove(context, argument, common),
  });
}

async function add(
  context: CommandContext,
  input: string | undefined,
  flags: Flags,
  common: CommonOptions,
): Promise<void> {
  if (input === undefined) {
    throw new AiregError("`aireg registry add` needs a registry address.", {
      code: ErrorCode.Usage,
      hint: "Name the address: `aireg registry add <address>`, such as github.com/owner/repo, a URL or a folder.",
    });
  }

  const loaded = await load(common, context.cwd, "user");

  // Reading it proves the address resolves and supplies the alias. A private one
  // cannot be read before it is declared, so an auth failure declares it anyway.
  let declared: RegistrySource;
  let alias: string;
  let label: string | undefined;
  let fromAddress = false;
  let readable = true;
  let move: Move | undefined;
  try {
    const source = await probe(input, flags, context.cwd);
    try {
      declared = {
        ...source.declared,
        location: recordedLocation(input, source.declared.location, loaded.roots),
      };
      alias = flags.as ?? source.alias;
      label = source.label;
      fromAddress = flags.as === undefined && source.named === "address";
      ({ declared, move } = await settle(context, loaded, common.dryRun, alias, declared, source));
    } finally {
      await source.close();
    }
  } catch (error) {
    if (!(error instanceof AiregError) || error.code !== ErrorCode.Unauthorized) throw error;
    // Adapters that manage credentials without a sign-in flow cannot recover after declaration.
    const failed = isAdapterError(error.cause)
      ? await loadAdapter(error.cause.adapter).catch(() => undefined)
      : undefined;
    if (failed?.credentialsHint !== undefined && !canSignIn(failed)) throw error;
    if (flags.as === undefined) {
      throw new AiregError(`Cannot read ${input} before you sign in, so it needs a name.`, {
        code: ErrorCode.Unauthorized,
        hint: `Run \`aireg registry add ${input} --as <name>\`, then \`aireg auth login <name>\`.`,
      });
    }
    declared = {
      location: recordedLocation(input, expandLocation(input, context.cwd), loaded.roots),
      adapter: flags.adapter,
      config: sourceConfig(flags),
    };
    alias = flags.as;
    readable = false;
    ({ declared, move } = await settle(context, loaded, common.dryRun, alias, declared, undefined));
  }

  const movedFrom = move === undefined ? {} : { movedFrom: move.from, kept: move.kept };
  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: { ...described(alias, declared), ...movedFrom, readable, dryRun: common.dryRun },
    });
    return;
  }
  if (move !== undefined) return moved(context, loaded.roots, alias, declared, move, common.dryRun);
  if (common.dryRun) {
    context.printer.info(
      `Would add registry ${alias} at ${withoutCredentials(declared.location)}.`,
    );
    context.printer.info(context.printer.style.dim("Dry run. Nothing was changed."));
    return;
  }
  context.printer.success(`Added registry ${alias} at ${withoutCredentials(declared.location)}.`);
  if (label !== undefined) context.printer.note("about", label);
  if (fromAddress) context.printer.note("named", "after its address; choose another with --as");
  noteUserScope(context.printer, common.scope, context.cwd);
  const g = loaded.roots.scope === "user" ? "-g " : "";
  // Login cannot store credentials while the registry token variable is set.
  const signIn = !readable && registryToken(alias) === undefined;
  if (signIn) context.printer.note("next", `aireg auth login ${alias}`);
  context.printer.note(signIn ? "then" : "next", `aireg add ${g}${alias}/<namespace>`);
}

/**
 * Decided and written under the scope's lease, against the manifest and lock as they are then,
 * so a command that writes the scope meanwhile is kept, not overwritten.
 */
async function settle(
  context: CommandContext,
  loaded: Loaded,
  dryRun: boolean,
  alias: string,
  declared: RegistrySource,
  source: Probed | undefined,
): Promise<{ declared: RegistrySource; move: Move | undefined }> {
  const decide = async ({ roots, manifest, lock }: Loaded) => {
    const move = await moveOf(roots, manifest, lock, alias, declared, source);
    const existing = manifest.registries[alias];
    // Another spelling of the same registry keeps the one its lock rows were resolved at.
    if (move !== undefined || existing === undefined) return { declared, move };
    return { declared: { ...declared, location: existing.location }, move };
  };
  if (dryRun) return decide(loaded);
  return withScope(
    loaded.roots,
    async (state) => {
      const settled = await decide(state);
      state.manifest.registries[alias] = settled.declared;
      await writeManifest(state.roots, state.manifest);
      if (settled.move !== undefined)
        await recordMove(state.roots, state.lock, alias, settled.declared, settled.move);
      return settled;
    },
    context.printer,
  );
}

/** Reports a move. Nothing installed is touched, since the new address was checked to serve it. */
async function moved(
  context: CommandContext,
  roots: Roots,
  alias: string,
  declared: RegistrySource,
  move: Move,
  dryRun: boolean,
): Promise<void> {
  const what = `registry ${alias} from ${withoutCredentials(move.from)} to ${withoutCredentials(declared.location)}`;
  const kept = plural(move.kept, "installed artifact");
  if (dryRun) {
    context.printer.info(`Would move ${what}, keeping ${kept}.`);
    context.printer.info(context.printer.style.dim("Dry run. Nothing was changed."));
    return;
  }
  context.printer.success(`Moved ${what}.`);
  context.printer.note("kept", kept);
  if (await signInLeftBehind(roots, alias, declared, move)) {
    context.printer.warning(
      `Your sign-in to ${alias} is for its old address, so it does not reach the new one.`,
    );
    context.printer.note("next", `aireg auth login ${alias}`);
  }
}

/** A registry is created where you are, as files; publishing it is your version control's job. */
async function init(
  context: CommandContext,
  input: string | undefined,
  flags: Flags,
  common: CommonOptions,
): Promise<void> {
  if (input !== undefined && REMOTE.test(input)) {
    throw new AiregError(
      "`aireg registry init` creates a registry in a folder, not at an address.",
      {
        code: ErrorCode.Usage,
        hint: "Clone the repository, cd into it, and run `aireg registry init`.",
      },
    );
  }
  const root = resolve(context.cwd, input ?? ".");
  const shown = relative(context.cwd, root) || ".";
  if (existsSync(join(root, REGISTRY_DOCUMENT))) {
    return extend(context, root, shown, namespacesOf(flags.namespace ?? []));
  }

  const step = interaction(context.printer, defaultIo(), common.yes);
  const suggested = (await remoteOwner(root)) ?? basename(root);
  const name =
    flags.name ??
    (await ask(step, "Name", suggested, `Type a name, or press Enter to use ${suggested}.`));
  if (name === undefined) return cancel(step);
  const description =
    flags.description ??
    (await ask(
      step,
      "Description",
      "",
      "Optional. Type one line, such as Skills our team shares.",
    ));
  if (description === undefined) return cancel(step);
  const listed =
    flags.namespace ??
    splitList(
      await ask(
        step,
        "Namespaces",
        "",
        "Optional. Type names separated by commas or spaces: engineering, data.",
      ),
    );
  if (listed === undefined) return cancel(step);
  const namespaces = namespacesOf(listed);

  refuseLinked(root, ["artifacts", ...namespaces.map((item) => `artifacts/${item}`)]);
  await mkdir(join(root, "artifacts"), { recursive: true });
  const written = await writeRoot(
    root,
    { name, ...(description === "" ? {} : { description }) },
    new Date().toISOString(),
  );
  for (const namespace of namespaces) {
    await mkdir(join(root, "artifacts", namespace), { recursive: true });
  }
  const slug = sanitizeName(name);

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { root, created: true, slug, namespaces } });
    return;
  }
  context.printer.success(`Created registry ${slug} in ${shown === "." ? "this folder" : shown}.`);
  for (const path of [...written, ...namespaces.map((item) => `artifacts/${item}/`)]) {
    context.printer.info(`    ${path}`);
  }
  const into = [shown === "." ? undefined : shown, namespaces[0] && `artifacts/${namespaces[0]}`]
    .filter(Boolean)
    .join("/");
  // Inside a namespace's folder, `skill new` knows the namespace; anywhere else it is named.
  const named = namespaces[0] === undefined ? " --namespace <namespace>" : "";
  context.printer.note(
    "next",
    `${into === "" ? "" : `cd ${into} && `}aireg skill new <name>${named}`,
  );
}

/** Each namespace once, or a usage error naming the ones that cannot be one. */
function namespacesOf(listed: readonly string[]): string[] {
  const namespaces = [...new Set(listed.map((item) => item.trim()).filter(Boolean))];
  const invalid = namespaces.filter((item) => !isNamespace(item));
  if (invalid.length > 0) {
    throw new AiregError(
      `${listOf(invalid.map(quoted))} ${invalid.length === 1 ? "is not a namespace" : "are not namespaces"}.`,
      {
        code: ErrorCode.Usage,
        hint: "Use lowercase letters, digits and hyphens, such as platform.",
      },
    );
  }
  return namespaces;
}

/**
 * A folder may already hold links, such as an `artifacts` one a cloned repository ships: one
 * anywhere from the root down to a folder `init` makes would put that folder somewhere else.
 */
function refuseLinked(root: string, folders: readonly string[]): void {
  for (const folder of folders) {
    const found = redirection(root, join(root, folder));
    if (found === undefined) continue;
    const what = found.problem === "symlink" ? "a symlink" : "not a folder";
    throw new AiregError(`${found.at} is ${what}, so nothing was written through it.`, {
      code: ErrorCode.Invalid,
      hint: "Replace it with a real folder, then run it again.",
    });
  }
}

/** `init` in a registry adds only the namespaces it was given; the registry itself is left as it is. */
async function extend(
  context: CommandContext,
  root: string,
  shown: string,
  namespaces: readonly string[],
): Promise<void> {
  const added = namespaces.filter((item) => !existsSync(join(root, "artifacts", item)));
  refuseLinked(
    root,
    added.map((item) => `artifacts/${item}`),
  );
  for (const namespace of added) {
    await mkdir(join(root, "artifacts", namespace), { recursive: true });
  }
  if (context.printer.format === "json") {
    const registry = await readRegistry(rootReader(root));
    const slug = registry.slug ?? registry.name;
    context.printer.json({ ok: true, data: { root, created: false, slug, namespaces: added } });
    return;
  }
  const where = shown === "." ? "This folder" : shown;
  if (added.length === 0) {
    context.printer.info(`${where} is already a registry. Nothing was changed.`);
    return;
  }
  context.printer.success(
    `Added ${plural(added.length, "namespace")} to the registry in ${shown === "." ? "this folder" : shown}: ${listOf(added)}.`,
  );
  for (const namespace of added) context.printer.info(`    artifacts/${namespace}/`);
}

/** The spec's indexer over a registry folder; releasing it is a commit, made by you. */
async function index(context: CommandContext, input: string | undefined): Promise<void> {
  const root = requireRegistry(resolve(context.cwd, input ?? "."));
  // What indexing repairs goes stale by design; anything else has to be fixed before it is released.
  const blocking = (await validateRoot(root)).problems.filter(
    (problem) => problem.path !== INDEX_DOCUMENT && problem.fix !== "aireg registry index",
  );
  if (blocking.length > 0) {
    for (const problem of blocking) {
      context.printer.error(`${problem.path}: ${problem.message}`);
      if (problem.fix !== undefined) context.printer.hint(problem.fix);
    }
    throw new AiregError(
      `The registry has ${plural(blocking.length, "problem")} to fix before it can be indexed.`,
      { code: ErrorCode.Invalid, hint: "Run `aireg registry validate` to see them again." },
    );
  }
  const { added, moved, paths } = await indexRoot(root, new Date().toISOString());
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { root, added, moved, paths } });
    return;
  }
  for (const item of moved) {
    context.printer.info(`  latest  ${item.namespace}/${item.kind}/${item.name}  ${item.version}`);
  }
  if (added.length === 0) {
    context.printer.success(
      moved.length > 0
        ? "Updated latest and index.json. No new versions."
        : paths.includes(INDEX_DOCUMENT)
          ? "Updated index.json. No new versions."
          : "Nothing new to index. Every version folder is listed.",
    );
    return;
  }
  for (const item of added) {
    context.printer.info(`  add     ${item.namespace}/${item.kind}/${item.name}  ${item.version}`);
  }
  context.printer.success(`Validated and indexed ${plural(added.length, "new version")}.`);
  const envelopes = paths.filter((path) => path.endsWith(ENVELOPE)).length;
  const versions = paths.filter((path) => path.endsWith(VERSIONS_DOCUMENT)).length;
  context.printer.note(
    "wrote",
    `index.json, ${plural(versions, "versions.json", "versions.json")}, ${plural(envelopes, "artifact.json", "artifact.json")}`,
  );
  if (!existsSync(join(root, ".git"))) return;
  context.printer.note(
    "next",
    commitAndPush(releaseSubject(added), relative(context.cwd, root) || "."),
  );
}

const MAX_PROBLEM = 2000;

/** A path as it is, or quoted with its escapes shown when a terminal would act on it, as git does. */
function pathText(path: string): string {
  const shown = quoted(path);
  return shown.slice(1, -1) === path ? path : shown;
}

/**
 * The merge gate: every problem with where it is and how to fix it, exit 1 on any.
 * In a pull request, released versions are compared with the branch it targets.
 */
async function validate(
  context: CommandContext,
  input: string | undefined,
  base: string | undefined,
): Promise<void> {
  const root = requireRegistry(resolve(context.cwd, input ?? "."));
  const target = process.env.GITHUB_BASE_REF;
  const against = base ?? (target === undefined || target === "" ? undefined : `origin/${target}`);
  const result = await validateRoot(root, { base: against });
  const { problems } = result;
  if (problems.length > 0) context.exit = ExitCode.Error;
  const hidden = await hiddenKinds(root);
  printHidden(context.printer, hidden);

  if (context.printer.format === "json") {
    const warnings = hidden.map((entry) => entry.message);
    context.printer.json({ ok: problems.length === 0, data: { ...result, warnings } });
    return;
  }
  if (inGitHubActions()) {
    const prefix = relative(process.env.GITHUB_WORKSPACE ?? root, root);
    for (const problem of problems) {
      const file = prefix === "" ? problem.path : `${prefix}/${problem.path}`;
      const fix = problem.fix === undefined ? "" : ` Fix: ${problem.fix}`;
      const message = `${problem.message}.${fix}`;
      context.printer.info(workflowCommand("error", { file, title: "registry" }, message));
    }
    const file = prefix === "" ? REGISTRY_DOCUMENT : `${prefix}/${REGISTRY_DOCUMENT}`;
    for (const entry of hidden) {
      context.printer.info(workflowCommand("warning", { file, title: "registry" }, entry.message));
    }
  }
  if (problems.length === 0) {
    context.printer.success(
      `${result.name} is valid: ${plural(result.namespaces, "namespace")}, ${plural(result.artifacts, "artifact")} and ${plural(result.versions, "version")}.`,
    );
    context.printer.success("The index is up to date.");
    return;
  }
  printProblems(context.printer, problems);
  context.printer.info(`Found ${plural(problems.length, "problem")}.`);
}

/**
 * Each file once, with every problem in it. A pull request names these paths,
 * and a newline in one would start a line of its own.
 */
function printProblems(
  printer: CommandContext["printer"],
  problems: readonly { path: string; message: string; fix?: string | undefined }[],
): void {
  const { style } = printer;
  const byPath = new Map<string, (typeof problems)[number][]>();
  for (const problem of problems) {
    byPath.set(problem.path, [...(byPath.get(problem.path) ?? []), problem]);
  }
  for (const [path, found] of byPath) {
    printer.info(`${style.red("✗")} ${pathText(path)}`);
    for (const problem of found) {
      printer.info(`    ${sanitizeText(problem.message, MAX_PROBLEM)}`);
      if (problem.fix !== undefined) {
        printer.info(style.dim(`    fix: ${sanitizeText(problem.fix, MAX_PROBLEM)}`));
      }
    }
  }
}

/** Valid by the spec, but aireg's own commands hide them from aireg users. */
async function hiddenKinds(root: string): Promise<Hidden[]> {
  return Object.keys(await kindsOf(root))
    .filter((kind) => RESERVED.has(kind))
    .map(hiddenKind);
}

/** Anything that reads as an address somewhere else, not a folder here. */
const REMOTE = /^[a-z+]+:\/\/|^[\w.-]+@[\w.-]+:|^[\w-]+(\.[\w-]+)+\//i;

/** Asked on a terminal; anywhere else, and under --yes, the suggestion is the answer. */
async function ask(
  step: Interaction,
  message: string,
  initial: string,
  hint: string,
): Promise<string | undefined> {
  if (!interactive(step)) return initial;
  const answer = await text({ message, style: step.printer.errStyle, initial, hint }, step.io);
  return canceled(answer) ? undefined : answer;
}

function splitList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(/[\s,]+/).filter(Boolean);
}

/** The owner of the repository this folder pushes to, which is who the registry is usually named for. */
async function remoteOwner(root: string): Promise<string | undefined> {
  const attempt = await gitIn(existsSync(root) ? root : dirname(root), [
    "remote",
    "get-url",
    "origin",
  ]);
  if (attempt.code !== 0) return undefined;
  try {
    return parseSource(attempt.stdout.trim()).slug?.split("/")[0];
  } catch {
    return undefined;
  }
}

/** A declared registry under `--json`, in the words every command uses. */
function described(alias: string, source: RegistrySource) {
  return {
    registry: alias,
    address: withoutCredentials(source.location),
    adapter: source.adapter,
    config: source.config,
  };
}

async function list(context: CommandContext, common: CommonOptions): Promise<void> {
  const loaded = await load(common, context.cwd, "user");
  const entries = Object.entries(loaded.manifest.registries);

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        scope: loaded.roots.scope,
        registries: entries.map(([alias, source]) => described(alias, source)),
      },
    });
    return;
  }
  if (entries.length === 0) {
    context.printer.info(`No registries declared in ${scopeName(loaded.roots.scope)}.`);
    context.printer.hint("Run `aireg registry add <address>` to add one.");
    return;
  }

  // What each alias installs, so the list answers "why is this here" too.
  const used = new Map<string, string[]>();
  for (const ref of loaded.manifest.artifacts) {
    used.set(ref.registry, [...(used.get(ref.registry) ?? []), formatRef(ref)]);
  }

  const style = context.printer.style;
  context.printer.info(
    style.bold(
      `${plural(entries.length, "registry", "registries")} in ${scopeName(loaded.roots.scope)}`,
    ),
  );
  table(
    context.printer,
    [
      { header: "name", value: ([alias]) => alias },
      { header: "address", value: ([, source]) => withoutCredentials(source.location) },
      { header: "ref", value: ([, source]) => source.config.ref ?? "", optional: true },
      { header: "path", value: ([, source]) => source.config.path ?? "", optional: true },
      { header: "adapter", value: ([, source]) => style.dim(source.adapter ?? ""), optional: true },
      {
        header: "installs",
        value: ([alias]) => {
          const refs = used.get(alias) ?? [];
          return refs.length === 0 ? style.dim("nothing") : refs.join(", ");
        },
      },
    ],
    entries,
  );
}

/** The pipeline stopping after its second stage: nothing is installed. */
async function show(
  context: CommandContext,
  input: string | undefined,
  flags: Flags,
  common: CommonOptions,
): Promise<void> {
  const target = input ?? (await onlyDeclared(context, common));
  const known = await knownRegistries(common, context.cwd);
  const resolved = throughManifest(target, known, flags);
  if (!resolved.declared) {
    const unknown = await undeclaredRegistry(target, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }
  const source = await probe(resolved.input, resolved.flags, context.cwd, [], resolved);
  const catalog = source.catalog;

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        registry: resolved.alias ?? source.alias,
        address: withoutCredentials(source.location),
        revision: source.revision,
        ...(isReadOnlyLayout(source.layout) ? { layout: source.layout } : {}),
        layouts: catalog.layouts,
        entries: catalog.entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          namespace: entry.group,
          path: entry.path,
          description: entry.description,
          engine: entry.engine,
          version: source.versionOf(entry),
        })),
        warnings: catalog.warnings,
      },
    });
    return;
  }

  const style = context.printer.style;
  const revision =
    source.revision === undefined ? "" : style.dim(` @ ${abbreviate(source.revision)}`);
  context.printer.info(`${style.bold(resolved.alias ?? source.alias)}${revision}`);
  fields(context.printer, [
    ["address", underHome(withoutCredentials(source.location))],
    [
      "layout",
      isReadOnlyLayout(source.layout)
        ? (source.layout as string)
        : catalog.layouts.join(" + ") || "none",
    ],
    ["artifacts", String(catalog.entries.length)],
  ]);

  if (catalog.entries.length === 0) {
    for (const warning of catalog.warnings) context.printer.warning(warning);
    return;
  }

  context.printer.info();
  table(
    context.printer,
    [
      {
        header: "artifact",
        value: (entry: Entry) =>
          entry.group === undefined ? entry.name : `${entry.group}/${entry.name}`,
      },
      { header: "kind", value: (entry: Entry) => style.dim(entry.kind) },
      {
        header: "needs",
        value: (entry: Entry) =>
          entry.engine === undefined ? "" : style.dim(`aireg ${entry.engine}`),
        optional: true,
      },
      { header: "description", value: (entry: Entry) => entry.description ?? "" },
    ],
    catalog.entries,
  );
  for (const warning of catalog.warnings) context.printer.warning(warning);
}

async function remove(
  context: CommandContext,
  alias: string | undefined,
  common: CommonOptions,
): Promise<void> {
  if (alias === undefined) {
    throw new AiregError("`aireg registry remove` needs a registry name.", {
      code: ErrorCode.Usage,
      hint: "Name the registry: `aireg registry remove <registry>`.",
    });
  }

  const loaded = await load(common, context.cwd, "user");
  const manifest = await readManifest(loaded.roots.manifest);
  if (manifest.registries[alias] === undefined) {
    throw unknownRegistry(alias, loaded.roots.scope, Object.keys(manifest.registries));
  }

  // Dropping the source of an installed artifact would leave the manifest
  // unresolvable, so say what to uninstall first rather than half-doing it.
  const dependents = manifest.artifacts.filter((ref) => ref.registry === alias);
  if (dependents.length > 0) throw stillDeclared(alias, dependents, loaded.lock);

  const jobs = registryJobs(await jobsConfig(context, alias), alias, loaded.roots);
  const removed = jobs.map((job) => job.id);
  const what = `registry ${alias}${jobsClause(jobs)}`;

  if (common.dryRun) {
    if (context.printer.format === "json") {
      context.printer.json({ ok: true, data: { registry: alias, dryRun: true, jobs: removed } });
      return;
    }
    context.printer.info(`Would remove ${what}.`);
    context.printer.info(context.printer.style.dim("Dry run. Nothing was changed."));
    return;
  }

  // The jobs go first: a job left behind fails every run once its registry is gone.
  if (removed.length > 0) await removeJobs(removed);
  delete manifest.registries[alias];
  await writeManifest(loaded.roots, manifest);

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { registry: alias, dryRun: false, jobs: removed } });
    return;
  }
  context.printer.success(`Removed ${what}.`);
  noteUserScope(context.printer, common.scope, context.cwd);
}

/** Counts what is installed, not manifest entries: an entry can cover nothing. */
function stillDeclared(alias: string, dependents: readonly Ref[], lock: Lock): AiregError {
  const installed = Object.values(lock.artifacts).filter((row) =>
    dependents.some((ref) => reaches(ref, row)),
  ).length;
  const named = listOf(dependents.map(formatRef));
  return new AiregError(
    installed > 0
      ? `Registry ${alias} still provides ${plural(installed, "installed artifact")}.`
      : `The manifest still takes ${named} from registry ${alias}.`,
    {
      code: ErrorCode.Conflict,
      hint: `Remove ${named} first with \`aireg remove\`.`,
    },
  );
}

/** Jobs live in config.yml; one this aireg cannot read leaves them as they are, and says so. */
async function jobsConfig(context: CommandContext, alias: string): Promise<RegistryConfig> {
  try {
    return await readConfig();
  } catch (error) {
    context.printer.warning(
      `Could not read your jobs, so any for registry ${alias} stays: ${(error as Error).message}`,
    );
    return emptyRegistryConfig();
  }
}

/** `aireg registry show` with no argument means the one this project declares. */
async function onlyDeclared(context: CommandContext, common: CommonOptions): Promise<string> {
  const loaded = await load(common, context.cwd, "user");
  const aliases = Object.keys(loaded.manifest.registries);
  if (aliases.length === 1) return aliases[0] as string;
  // In a clone of a registry, it is the one meant.
  const here = aliases.length === 0 ? findRegistry(context.cwd) : undefined;
  if (here !== undefined) return here;
  throw new AiregError("`aireg registry show` needs a registry name.", {
    code: ErrorCode.Usage,
    hint:
      aliases.length === 0
        ? "Name the registry: `aireg registry show <registry>`, such as github.com/owner/repo, a URL or a folder."
        : `Name one of ${listOf(aliases, "or")}: \`aireg registry show <registry>\`.`,
  });
}
