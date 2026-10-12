import { existsSync } from "node:fs";
import { join } from "node:path";
import { list, plural, quoted, sanitizeName, withoutCredentials } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import {
  cancel,
  chooseArtifacts,
  chooseMethod,
  chooseScope,
  chooseTargets,
  confirmPlan,
  equivalent,
  type Interaction,
  interaction,
  interactive,
  methodIsMeaningful,
  pickedNamespace,
  preparing,
} from "#cli/prompt/flow.ts";
import { canAnimate, canceled, defaultIo, spinner } from "#cli/prompt/index.ts";
import {
  aliasFor,
  asAddress,
  chooseRegistry,
  knownRegistries,
  sameLocation,
  undeclaredRegistry,
} from "#cli/registries.ts";
import { outcome, planReport, type Ran, summarize } from "#cli/render/plan.ts";
import { noteUserScope } from "#cli/render/where.ts";
import {
  among,
  atAddress,
  insideRegistry,
  type Probed,
  probeAddress,
  type Resolved,
  relativeRef,
  rememberSource,
  type SourceFlags,
  throughManifest,
  throughRegistry,
  wantOf,
} from "#cli/source.ts";
import { expandLocation, recordedLocation } from "#core/adapter/location.ts";
import { type Entry, withoutCoveredLeaves } from "#core/catalog/model.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { coveredByWhole, type RegistrySource } from "#core/manifest.ts";
import { abbreviate } from "#core/output.ts";
import { reached } from "#core/plan/acquire.ts";
import type { Selected } from "#core/plan/model.ts";
import {
  formatAddress,
  formatRef,
  parseRef,
  type Ref,
  relativeTo,
  withExclusions,
} from "#core/ref.ts";
import { MANIFEST_FILE, SCOPE_DIR, type Scope, scopeFor, userScopeDir } from "#core/store/paths.ts";
import { autostartState } from "#daemon/autostart/index.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import { withDaemon } from "#daemon/service.ts";
import type { CommonOptions } from "#engine/options.ts";
import {
  load,
  locate,
  resolveScope,
  resolveTargets,
  run as runPipeline,
} from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

/** Require explicit confirmation before a large implicit selection. */
const CONFIRM_ABOVE = 10;

interface Choices {
  /** Manifest addresses: a leaf carries its plugin. */
  select: string[] | undefined;
  targets: string[] | undefined;
  scope: Scope;
  copy: boolean;
  /** Kinds this selection covers, so the plan can explain what got nothing. */
  kinds: ArtifactKind[];
}

interface Gathered {
  choices: Choices;
  loaded: Awaited<ReturnType<typeof load>>;
}

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common, own } = parse<AddFlags>(context.argv, builtin("add"));
  const step = interaction(context.printer, defaultIo(), common.yes);

  // An address may name a registry this scope declares, or one declared for
  // the user; a project that installs through a user alias records it as its own.
  const known = await knownRegistries(common, context.cwd);
  const typed = own.registry ?? positionals[0] ?? (await chooseRegistry(step, known));
  if (typed === undefined) {
    cancel(step);
    return;
  }
  const {
    input,
    resolved,
    inside: within,
    exact,
    picks,
  } = await commandLineAddress(own, positionals, typed, known, common, context.cwd);
  if (!resolved.declared) {
    const unknown = await undeclaredRegistry(input, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }

  const namespace = selectScope(input, resolved, picks, within);

  // The address carries the selection when it named one, so every later step
  // reads it the same way `--select` would have been read.
  const asked: CommonOptions =
    picks.select !== undefined || resolved.name === undefined
      ? picks
      : { ...picks, select: [resolved.name] };
  const named = asked.select?.includes("*") === true ? undefined : asked.select;
  // Only one address is read on its own: a `--select` value may name a
  // namespace, which the catalog has to be read to recognize.
  const partial = resolved.name !== undefined && picks.select === undefined;
  // An address that says what to install is the whole answer; only a bare one is asked about.
  const complete = picks.select !== undefined || exact;
  const asking: Interaction = complete
    ? { ...step, blocked: step.blocked ?? { kind: "yes" } }
    : step;
  preparing(asking);

  const { source } = await read(step, context, resolved, partial, named, namespace);
  const { catalogAlias, entries } = entriesFor(source, resolved, partial, namespace);

  const gathered = await gather(
    asking,
    asked,
    context.cwd,
    showable(resolved),
    entries,
    partial,
    catalogAlias,
  );
  if (gathered === undefined) {
    cancel(step);
    return;
  }
  const { choices, loaded } = gathered;

  // An address the manifest already resolves keeps the alias it was declared
  // under; anything else is named after the source it came from.
  const alias = resolved.declared
    ? aliasFor(input, true, known, source)
    : (own.as ?? aliasFor(input, false, known, source));

  // Taking everything an address names is the address itself, not the whole
  // registry: `add acme/my-team --all` must not drag in every other team.
  const whole = resolved.declared ? input : [alias, within].filter(Boolean).join("/");
  const refs = choices.select === undefined ? [whole] : choices.select.map((n) => pin(alias, n));

  function pin(registry: string, qualified: string): string {
    const address = `${registry}/${qualified}`;
    const leaf = qualified.split("/").at(-1);
    return resolved.version !== undefined && leaf === resolved.name
      ? `${address}@${resolved.version}`
      : address;
  }

  const effective: CommonOptions = {
    ...asked,
    scope: choices.scope,
    targets: undefined,
    // `--copy` is recorded on the entries this adds, so the rest of the scope is not copied.
    copy: false,
  };

  let approved = true;
  let introduced = false;
  let copied = false;
  let repinned: Repin[] = [];
  let { location, config } = source.declared;
  const result = await runPipeline(
    loaded.roots,
    effective,
    context.printer,
    context.cwd,
    planReport(context.printer),
    (fresh) => {
      const { manifest, roots } = fresh;
      const holder = manifest.registries[alias] ?? known[alias];
      if (
        !resolved.declared &&
        holder !== undefined &&
        !sameLocation(expandLocation(holder.location, roots.base), source.declared.location)
      ) {
        throw new AiregError(
          `The name ${quoted(alias)} is already taken by ${withoutCredentials(holder.location)}.`,
          {
            code: ErrorCode.Usage,
            hint: "Pass `--as <name>` to save this registry under another name.",
          },
        );
      }
      introduced = manifest.registries[alias] === undefined && known[alias] === undefined;
      copied =
        roots.scope !== "user" &&
        manifest.registries[alias] === undefined &&
        known[alias] !== undefined;
      const recorded = rememberSource(holder, {
        ...source.declared,
        location: recordedLocation(resolved.input, source.declared.location, roots),
      });
      manifest.registries[alias] = recorded;
      ({ location, config } = recorded);

      const narrowed = narrowedTargets(fresh, asked, choices.targets);

      repinned = declare(manifest.artifacts, refs, narrowed, choices.copy, (ref) =>
        reached(fresh.lock, ref).at(0),
      );
      manifest.artifacts = manifest.artifacts.filter(
        (ref) => !coveredByWhole(ref, manifest.artifacts),
      );

      return {
        // Every other registry stays as the lock has it, so adding one skill
        // does not fetch and re-plan the whole scope.
        aliases: [alias],
        // Naming something already locked is asking for its newest version again.
        moving: new Set(refs.flatMap((text) => reached(fresh.lock, parseRef(text)))),
        // A whole namespace still installs the rest when one member's name is taken.
        adding: new Set(
          refs.map(parseRef).flatMap((ref) => (ref.name === undefined ? [] : [formatAddress(ref)])),
        ),
        approve: async (plan, targets) => {
          approved = await confirmPlan(asking, plan, {
            verb: "Install",
            // The harnesses picked for this add, which an entry may narrow from the scope's.
            targets: choices.targets ?? targets,
            kinds: choices.kinds,
            harnesses: fresh.harnesses,
          });
          return approved;
        },
      };
    },
  );

  if (!approved) {
    cancel(step);
    return;
  }

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        registry: alias,
        artifacts: refs,
        dependencies: result.plan.neededBy,
        ...outcome(result, common.dryRun),
      },
    });
    return;
  }

  if (result.applied !== undefined) {
    await reportAdded(context, {
      alias,
      source,
      location,
      config,
      named: own.as !== undefined,
      introduced,
      copied,
      repinned,
      ran: { ...result, applied: result.applied },
      scope: choices.scope,
      autoUpdate: own["no-auto-update"] !== true,
      pinned: refs.every((text) => parseRef(text).version !== undefined),
    });
  }
  if (choices.scope === "user") noteUserScope(context.printer, common.scope, context.cwd);
  if (interactive(asking) && result.applied !== undefined) {
    context.printer.info(
      context.printer.style.dim(
        `  ${equivalent("add", input, { ...choices, select: shortened(choices.select, entries) })}`,
      ),
    );
  }
}

/** What an applied add changed: the registry it introduced, then the plan's summary. */
async function reportAdded(
  context: CommandContext,
  added: {
    alias: string;
    source: Probed;
    location: string;
    config: Readonly<Record<string, string>>;
    named: boolean;
    introduced: boolean;
    copied: boolean;
    repinned: readonly Repin[];
    ran: Ran;
    scope: Scope;
    autoUpdate: boolean;
    /** Every artifact named was pinned, so background updates leave it where it is. */
    pinned: boolean;
  },
): Promise<void> {
  const { printer } = context;
  const { alias, source } = added;
  if (added.introduced) {
    printer.success(`Added registry ${alias} at ${withoutCredentials(added.location)}.`);
    if (source.label !== undefined) printer.note("about", source.label);
    if (!added.named && source.named === "address") {
      printer.note("named", "after its address; choose another with --as");
    }
  }
  if (added.copied) printer.success(`Added registry ${alias} to this project's manifest.`);
  for (const { name, version } of added.repinned) {
    printer.success(version === undefined ? `Unpinned ${name}.` : `Pinned ${name} at ${version}.`);
  }
  // A pin that moved nothing is said once, by the line above, rather than as "Already up to date".
  const acted = new Set(
    added.ran.plan.actions.flatMap((action) => ("name" in action ? [action.name] : [])),
  );
  const said = added.repinned.map((item) => item.name).filter((name) => !acted.has(name));
  summarize(printer, added.ran, new Set(said));
  if (added.scope === "user" && added.autoUpdate) {
    await keepCurrent(context, alias, added.config, added.pinned);
  }
}

type AddFlags = SourceFlags & { as?: string; registry?: string; "no-auto-update"?: boolean };

/** What the command line names, with a link to one artifact read as that artifact. */
async function commandLineAddress(
  own: AddFlags,
  positionals: string[],
  typed: string,
  known: Record<string, RegistrySource>,
  common: CommonOptions,
  cwd: string,
): Promise<Addressed> {
  // A named adapter reads a folder its own way, so it is handed the path unchanged.
  const link =
    own.registry === undefined && own.adapter === undefined && positionals.length === 1
      ? await insideRegistry(typed, cwd)
      : undefined;
  if (link === undefined) return addressed(typed, own.registry, positionals, known, own, common);
  const flags = { ...own, ref: own.ref ?? link.flags.ref, path: own.path ?? link.flags.path };
  return addressed(link.registry, link.registry, [link.address], known, flags, common);
}

/** The catalog entries an address reaches; one address picks one entry. */
function entriesFor(
  source: Probed,
  resolved: Resolved,
  partial: boolean,
  namespace: string | undefined,
): { catalogAlias: string; entries: readonly Entry[] } {
  const catalogAlias = resolved.alias ?? source.alias;
  const all = source.catalog.entries;
  const entries = partial ? atAddress(resolved, all, catalogAlias) : inside(all, namespace);
  const plugin = (entry: Entry) => entry.kind === "plugin" && entry.name === namespace;
  if (namespace !== undefined && entries.length === 0 && !all.some(plugin)) {
    throw new AiregError(`No namespace named ${quoted(namespace)} in ${catalogAlias}.`, {
      code: ErrorCode.NotFound,
      hint: `Run \`aireg registry show ${showable(resolved)}\` to see what it publishes.`,
    });
  }
  return { catalogAlias, entries };
}

/**
 * One background job per registry keeps the user scope current. It is created
 * once and never rewritten, so a policy someone set stays set.
 */
async function keepCurrent(
  context: CommandContext,
  alias: string,
  config: Readonly<Record<string, string>>,
  pinned: boolean,
): Promise<void> {
  try {
    await withDaemon(async (client) => {
      await withFreshConfig(client, async (state) => {
        const account = state.accounts.find((item) => item.registry === alias);
        const watched = state.jobs.some(
          (job) =>
            job.account === account?.id &&
            job.steps.some((step) => step.root !== undefined && scopeFor(step.root) === "user"),
        );
        if (watched) return;
        await client.request("job.create", {
          expectedRevision: state.revision,
          root: userScopeDir(),
          scope: "user",
          registry: alias,
          config,
          declaredOnly: true,
        });
      });
    });
  } catch (error) {
    context.printer.warning(
      `Installed, but could not turn on background updates: ${(error as Error).message}`,
    );
    context.printer.hint(`Run \`aireg job add -g --registry ${alias}\` to try again.`);
    return;
  }
  context.printer.note(
    "kept",
    pinned
      ? "at the version pinned; background updates leave it there"
      : `up to date every ${DEFAULT_INTERVAL_WORDS}, in the background`,
  );
  const autostart = await autostartState().catch(() => undefined);
  if (autostart !== undefined && !autostart.registered) {
    context.printer.note("next", "aireg daemon autostart on");
  }
}

/**
 * Recorded on the entry only when they differ from the scope's, so a narrowed add
 * never unlinks anything else; picking exactly the scope's widens it back.
 */
function narrowedTargets(
  loaded: Awaited<ReturnType<typeof load>>,
  common: CommonOptions,
  picked: string[] | undefined,
): string[] | "scope" | undefined {
  if (picked === undefined) return undefined;
  const wanted = resolveTargets(loaded.manifest, loaded.harnesses, { ...common, targets: picked });
  const scope = resolveTargets(loaded.manifest, loaded.harnesses, {
    ...common,
    targets: undefined,
  });
  const same = wanted.length === scope.length && wanted.every((name) => scope.includes(name));
  return same ? "scope" : wanted;
}

/** An artifact the manifest already asked for, now asked for at another version, or at none. */
interface Repin {
  name: string;
  version: string | undefined;
}

/**
 * Keyed by address, not the whole reference, so adding again at another version
 * re-pins the entry; a member a whole ref excludes is taken back into that ref.
 */
function declare(
  artifacts: Ref[],
  refs: readonly string[],
  narrowed: string[] | "scope" | undefined,
  copy: boolean,
  /** The lockfile's name for what a ref already installs, if anything. */
  installedAs: (ref: Ref) => string | undefined,
): Repin[] {
  const repinned: Repin[] = [];
  const declaredAt = new Map(artifacts.map((ref, index) => [formatAddress(ref), index]));
  for (const text of refs) {
    const already = declaredAt.get(formatAddress(parseRef(text)));
    const held = already === undefined ? undefined : artifacts[already];
    const ref: Ref = {
      ...parseRef(text),
      targets: narrowed === "scope" ? undefined : (narrowed ?? held?.targets),
      ...(copy || held?.copy === true ? { copy: true } : {}),
    };
    readmit(artifacts, ref);
    const name = ref.name === undefined ? undefined : (installedAs(ref) ?? ref.name);
    if (already === undefined) {
      declaredAt.set(formatAddress(ref), artifacts.length);
      artifacts.push(ref);
      // A pin on something a whole namespace installed is a pin all the same.
      if (name !== undefined && ref.version !== undefined && installedAs(ref) !== undefined) {
        repinned.push({ name, version: ref.version });
      }
      continue;
    }
    const declared = artifacts[already] as Ref;
    if (name !== undefined && declared.version !== ref.version) {
      repinned.push({ name, version: ref.version });
    }
    if (
      formatRef(declared) !== formatRef(ref) ||
      declared.exclude !== undefined ||
      declared.targets?.join() !== ref.targets?.join() ||
      declared.copy !== ref.copy
    ) {
      artifacts[already] = ref;
    }
  }
  return repinned;
}

function readmit(artifacts: Ref[], added: Ref): void {
  if (added.name === undefined || added.kind === undefined) return;
  artifacts.forEach((ref, index) => {
    if (ref.exclude === undefined || ref.registry !== added.registry) return;
    if (ref.namespace !== undefined && ref.namespace !== added.namespace) return;
    const at = relativeTo(ref, {
      namespace: added.namespace,
      kind: added.kind as string,
      name: sanitizeName(added.name as string),
    });
    artifacts[index] = withExclusions(
      ref,
      ref.exclude.filter((item) => item !== at),
    );
  });
}

/** What `aireg registry show` takes for this registry: its declared name, or the address as typed. */
function showable(resolved: Resolved): string {
  return resolved.alias ?? withoutCredentials(resolved.input);
}

/** Reads the source once, under a spinner on a terminal; a source that publishes nothing is an error. */
async function read(
  step: Interaction,
  context: CommandContext,
  resolved: Resolved,
  partial: boolean,
  named: readonly string[] | undefined,
  namespace: string | undefined,
): Promise<{ source: Probed }> {
  const spin =
    context.printer.quiet || context.printer.format === "json" || !canAnimate(step.io.output)
      ? undefined
      : spinner(step.io, context.printer.errStyle);
  spin?.update(`Reading ${showable(resolved)}`);
  let source: Probed;
  try {
    source = await probeAddress(resolved, context.cwd, partial ? wantOf(resolved) : []);
  } catch (error) {
    spin?.stop();
    throw error;
  }

  const registry = resolved.alias ?? source.alias;
  const catalog = source.catalog;
  if (catalog.entries.length === 0) {
    spin?.stop();
    throw new AiregError(
      named === undefined
        ? `${registry} publishes no artifacts.`
        : `${registry} publishes nothing named ${list(named.map(quoted), "or")}.`,
      {
        code: ErrorCode.NotFound,
        hint: `Run \`aireg registry show ${showable(resolved)}\` to see what it publishes.`,
      },
    );
  }

  // Whole-registry installs skip leaves a plugin already covers; an address
  // may still name one of them.
  const publishes = withoutCoveredLeaves(catalog.entries);
  const at = source.revision === undefined ? "" : ` at ${abbreviate(source.revision)}`;
  // The cap counts the namespace on its own, so its count is shown beside the source's.
  const within =
    namespace === undefined
      ? ""
      : `, ${withoutCoveredLeaves(inside(catalog.entries, namespace)).length} in ${namespace}`;
  spin?.stop(`${registry}${at} publishes ${plural(publishes.length, "artifact")}${within}`);

  return { source };
}

/** Gather missing choices; cancellation returns no choices. */
async function gather(
  step: Interaction,
  common: CommonOptions,
  cwd: string,
  /** What `aireg registry show` takes for this registry. */
  shown: string,
  all: readonly Entry[],
  partial: boolean,
  alias: string,
): Promise<Gathered | undefined> {
  const picked = await pickArtifacts(step, common, shown, all, partial, alias);
  if (picked === undefined) return undefined;

  const located = locate(common.scope, cwd);
  let scope = located?.scope;
  const undecided =
    located === undefined || !existsSync(join(located.base, SCOPE_DIR, MANIFEST_FILE));
  if (common.scope === undefined && undecided && interactive(step)) {
    const picked = await chooseScope(step, scope ?? "user");
    if (canceled(picked)) return undefined;
    scope = picked;
  }
  // Outside a project the user scope is the only one there is, as for `aireg registry add`.
  scope ??= resolveScope(undefined, cwd, "user").scope;

  // Loaded under the chosen scope, so the paths shown in the prompt are real.
  const loaded = await load({ ...common, scope }, cwd);
  const { manifest, harnesses } = loaded;
  const chosen = chosenEntries(picked.addresses, all);
  let targets = common.targets;
  if (targets === undefined && interactive(step)) {
    const items = chosen.map((entry) => asSelected(entry, alias));
    const picked = await chooseTargets(step, harnesses, loaded.roots, manifest.targets, items);
    if (canceled(picked)) return undefined;
    targets = picked;
  }

  const kinds = [...new Set(chosen.map((entry) => entry.kind))];
  let copy = common.copy;
  if (
    !copy &&
    interactive(step) &&
    methodIsMeaningful(harnesses, targets ?? [], scope, cwd, kinds)
  ) {
    const picked = await chooseMethod(step, copy);
    if (canceled(picked)) return undefined;
    copy = picked;
  }

  return {
    choices: { select: picked.addresses, targets, scope, copy, kinds },
    loaded,
  };
}

/** `undefined` names means the whole registry, matching the manifest shape. */
async function pickArtifacts(
  step: Interaction,
  common: CommonOptions,
  shown: string,
  all: readonly Entry[],
  partial: boolean,
  alias: string,
): Promise<Picked | undefined> {
  if (common.select?.includes("*") === true) return { addresses: undefined };

  if (common.select !== undefined) {
    return { addresses: qualify(common.select, shown, all, partial, alias) };
  }

  if (interactive(step)) {
    const picked = await chooseArtifacts(step, all, []);
    if (canceled(picked)) return undefined;
    return { addresses: qualify(picked, shown, all, false, alias) };
  }

  // Leaves a plugin already covers are not counted; an explicit -s may still name one.
  const taking = withoutCoveredLeaves(all);
  if (taking.length > CONFIRM_ABOVE) {
    throw new AiregError(`Installing ${plural(taking.length, "artifact")} needs confirmation.`, {
      code: ErrorCode.Usage,
      hint: "Pick some with `-s <name>`, or pass `--all` to install them all.",
    });
  }
  return { addresses: undefined };
}

interface Picked {
  addresses: string[] | undefined;
}

/** The kinds a selection covers; every kind when the whole registry is taken. */
function chosenEntries(addresses: readonly string[] | undefined, all: readonly Entry[]): Entry[] {
  const leaf = (address: string): string =>
    sanitizeName((address.split("@")[0] as string).split("/").at(-1) as string);
  const wanted = addresses === undefined ? undefined : new Set(addresses.map(leaf));
  // A bare namespace is every member of it.
  const namespaces = new Set((addresses ?? []).filter((address) => !address.includes("/")));
  return all.filter(
    (entry) =>
      wanted === undefined ||
      wanted.has(entry.name) ||
      (entry.group !== undefined && namespaces.has(entry.group)),
  );
}

/** A catalog entry as the plan would place it, for showing where each harness loads it from. */
function asSelected(entry: Entry, alias: string): Selected {
  return {
    name: entry.name,
    kind: entry.kind,
    source: alias,
    path: entry.path,
    id: entry.path,
    upstreamName: entry.name,
    contentId: undefined,
    version: undefined,
    contents: [],
    group: entry.group,
  };
}

/**
 * Each pick as the manifest records it: `<namespace>/<kind>/<name>`, or
 * `<kind>/<name>` where the source groups nothing. A plugin is its namespace.
 */
export function qualify(
  picks: readonly string[],
  /** What `aireg registry show` takes for this registry. */
  shown: string,
  all: readonly Entry[],
  /** True when only the requested names were read, so `all` is not the catalog. */
  partial: boolean,
  alias: string,
): string[] {
  const addresses: string[] = [];
  const missing: string[] = [];
  for (const pick of picks) {
    const address = addressOf(pick, all, alias);
    if (address === undefined) missing.push(pick);
    else addresses.push(address);
  }
  if (missing.length > 0) {
    // Several plugins may publish the same leaf.
    const available = [...new Set(all.map((entry) => entry.name))].sort();
    throw new AiregError(`${alias} publishes nothing named ${list(missing.map(quoted), "or")}.`, {
      code: ErrorCode.NotFound,
      // A partial read cannot provide a complete catalog hint.
      hint: partial
        ? `Run \`aireg registry show ${shown}\` to see what it publishes.`
        : `Use ${list(available, "or")}.`,
    });
  }
  return addresses;
}

/** One word names an artifact, or a namespace when no artifact has that name. */
function addressOf(pick: string, all: readonly Entry[], alias: string): string | undefined {
  const namespaces = new Set(
    all.flatMap((entry) => (entry.group === undefined ? [] : [entry.group])),
  );
  const whole = pickedNamespace(pick);
  if (whole !== undefined) return namespaces.has(whole) ? whole : undefined;

  const ref = relativeRef(pick);
  const word = ref.name ?? (ref.namespace as string);
  const [entry] = among(
    all,
    alias,
    ref.name === undefined
      ? { name: word }
      : { name: ref.name, namespace: ref.namespace, kind: ref.kind },
  );
  if (entry !== undefined) {
    const address = [entry.group, entry.kind, entry.name].filter(Boolean).join("/");
    return ref.version === undefined ? address : `${address}@${ref.version}`;
  }
  const plugin = all.some((candidate) => candidate.kind === "plugin" && candidate.name === word);
  return ref.name === undefined && (namespaces.has(word) || plugin) ? word : undefined;
}

/** One address per command; several artifacts are picked inside it with -s. */
function refuseExtra(positionals: readonly string[]): void {
  if (positionals.length <= 1) return;
  throw new AiregError("`aireg add` takes one address.", {
    code: ErrorCode.Usage,
    hint: "Pick several inside it: `aireg add <registry>[/<namespace>] -s <name> -s <name>`.",
  });
}

interface Addressed {
  input: string;
  resolved: Resolved;
  /** The options with any picks the positionals made. */
  picks: CommonOptions;
  /** For a source named with --registry, the address inside it. */
  inside: string | undefined;
  /** Whether the command line says exactly what to install, so nothing is asked. */
  exact: boolean;
}

/**
 * What the command line names. With --registry, one positional is an address
 * inside it and several are picks, read as -s reads them.
 */
function addressed(
  typed: string,
  registry: string | undefined,
  positionals: string[],
  known: Record<string, RegistrySource>,
  flags: SourceFlags,
  common: CommonOptions,
): Addressed {
  if (registry === undefined) {
    refuseExtra(positionals);
    return through(asAddress(typed, known), known, flags, common);
  }
  // One word reads as -s reads it, an artifact before a namespace, unless -s
  // picks inside it; then it is the namespace to pick from.
  const [first] = positionals;
  const oneWord = first !== undefined && !first.includes("/") && common.select === undefined;
  if (positionals.length > 1 || oneWord) {
    if (common.select !== undefined && !common.all) {
      throw new AiregError("Names were given both as arguments and with -s.", {
        code: ErrorCode.Usage,
        hint: "Use one: `aireg add <namespace>/<name>... -r <registry>` or `aireg add <namespace> -r <registry> -s <name>`.",
      });
    }
    const whole = through(asAddress(typed, known), known, flags, common);
    return { ...whole, picks: { ...common, select: common.select ?? positionals }, exact: true };
  }
  const relative = first;
  if (relative === undefined) return through(asAddress(typed, known), known, flags, common);
  const resolved = throughRegistry(typed, relative, known, flags);
  return resolved.declared
    ? { input: `${typed}/${relative}`, resolved, picks: common, inside: undefined, exact: true }
    : { input: typed, resolved, picks: common, inside: relative, exact: true };
}

function through(
  input: string,
  known: Record<string, RegistrySource>,
  flags: SourceFlags,
  common: CommonOptions,
): Addressed {
  const resolved = throughManifest(input, known, flags);
  const exact = resolved.declared && input.includes("/");
  return { input, resolved, picks: common, inside: undefined, exact };
}

/**
 * The namespace `-s` reads inside, when the address names one. An address that
 * already names one artifact leaves `-s` nothing to pick.
 */
function selectScope(
  input: string,
  resolved: Resolved,
  common: CommonOptions,
  within: string | undefined,
): string | undefined {
  if (resolved.name !== undefined) {
    if (common.select === undefined || common.all) return undefined;
    throw new AiregError(`${quoted(input)} names one artifact, so -s has nothing to pick.`, {
      code: ErrorCode.Usage,
      hint: "Drop -s, or end the address at a registry or namespace to pick inside it.",
    });
  }
  // A declared address carries its registry; an address given after -r does not.
  const scope = resolved.declared ? input : within && `registry/${within}`;
  if (!scope) return undefined;
  try {
    const namespace = parseRef(scope).namespace;
    return namespace === undefined ? undefined : sanitizeName(namespace);
  } catch {
    return undefined;
  }
}

/** A namespace address narrows the catalog, so `-s` cannot reach past it. */
function inside(entries: readonly Entry[], namespace: string | undefined): readonly Entry[] {
  return namespace === undefined ? entries : entries.filter((entry) => entry.group === namespace);
}

/** The hint's addresses: the kind only where a namespace has two artifacts of one name. */
function shortened(addresses: string[] | undefined, all: readonly Entry[]): string[] | undefined {
  return addresses?.map((address) => {
    const [namespace, kind, name] = address.split("/");
    if (name === undefined || kind === undefined) return address;
    const same = all.filter((entry) => entry.group === namespace && entry.name === name);
    return same.length === 1 ? `${namespace}/${name}` : address;
  });
}
