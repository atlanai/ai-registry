import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isReadOnlyLayout, type LayoutId } from "#adapter/layouts/ids.ts";
import { expandHome } from "#adapter/paths.ts";
import { list, plural, quoted, sanitizeName, withoutCredentials } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import {
  cancel,
  chooseArtifacts,
  chooseMethod,
  chooseScope,
  chooseTargets,
  confirmPlan,
  confirmTrust,
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
import { settleCollisions } from "#cli/render/collisions.ts";
import { outcome, planReport, type Ran, summarize } from "#cli/render/plan.ts";
import { noteUserScope } from "#cli/render/where.ts";
import { type LockedSkill, readSkillLock } from "#cli/skill-locks.ts";
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
import { withheldAt, withheldMessage } from "#core/catalog/withheld.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { coveredByWhole, type RegistrySource } from "#core/manifest.ts";
import { abbreviate } from "#core/output.ts";
import { reached } from "#core/plan/acquire.ts";
import { describeCarried } from "#core/plan/carries.ts";
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
  type Loaded,
  load,
  locate,
  type RunResult,
  resolveScope,
  run as runPipeline,
  selectTargets,
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
  const parsed = parse<AddFlags>(context.argv, builtin("add"));
  if (parsed.own.from !== undefined) return addFrom(context, parsed, parsed.own.from);
  return addAddress(context, parsed);
}

/**
 * Adds what another installer's lock file records, one source at a time, taking over each copy
 * already on disk that holds exactly what aireg installs.
 */
async function addFrom(context: CommandContext, parsed: Parsed, from: string): Promise<void> {
  const { positionals, common, own } = parsed;
  if (positionals.length > 0 || own.registry !== undefined || common.select !== undefined) {
    throw new AiregError("`aireg add --from` takes no address and no -s.", {
      code: ErrorCode.Usage,
      hint: "Run `aireg add --from <file>` on its own: the file says what to add.",
    });
  }
  const lock = await readSkillLock(resolve(context.cwd, expandHome(from)));
  for (const skipped of lock.skipped) context.printer.warning(skipped);
  if (lock.skills.length === 0) {
    throw new AiregError(`${from} records no skill aireg can add.`, { code: ErrorCode.NotFound });
  }
  const sources = new Map<string, LockedSkill[]>();
  for (const skill of lock.skills) {
    const key = `${skill.address}\u0000${skill.ref ?? ""}`;
    sources.set(key, [...(sources.get(key) ?? []), skill]);
  }
  const scope = common.scope ?? (lock.user ? "user" : undefined);
  for (const skills of sources.values()) {
    const [first] = skills as [LockedSkill, ...LockedSkill[]];
    for (const skill of skills) {
      const folder = skill.folder === "." ? undefined : basename(skill.folder);
      if (folder !== undefined && folder !== skill.name) {
        context.printer.warning(
          `${quoted(skill.name)} installs as ${quoted(folder)}, the name of its folder, so a copy under ${quoted(skill.name)} stays as it is.`,
        );
      }
    }
    const names = skills.map((skill) =>
      skill.folder === "." ? skill.name : basename(skill.folder),
    );
    await addAddress(
      context,
      {
        positionals: [first.address],
        common: { ...common, scope, select: names },
        own: { ...own, from: undefined, ...(first.ref === undefined ? {} : { ref: first.ref }) },
      },
      new Set(names),
    );
  }
}

/** Saves the registry under `alias` in this scope, refusing a name another address holds. */
function recordRegistry(
  fresh: Loaded,
  alias: string,
  known: Readonly<Record<string, RegistrySource>>,
  source: Probed,
  resolved: Resolved,
): { introduced: boolean; copied: boolean; recorded: RegistrySource } {
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
  const introduced = manifest.registries[alias] === undefined && known[alias] === undefined;
  const copied =
    roots.scope !== "user" &&
    manifest.registries[alias] === undefined &&
    known[alias] !== undefined;
  const recorded = rememberSource(holder, {
    ...source.declared,
    location: recordedLocation(resolved.input, source.declared.location, roots),
  });
  manifest.registries[alias] = recorded;
  return { introduced, copied, recorded };
}

type Parsed = ReturnType<typeof parse<AddFlags>>;

/** The address read and what it offers, before anything is asked; undefined when canceled. */
async function openAddress(
  context: CommandContext,
  { positionals, common, own }: Parsed,
  step: Interaction,
) {
  // An address may name a registry this scope declares, or one declared for
  // the user; a project that installs through a user alias records it as its own.
  const known = await knownRegistries(common, context.cwd);
  const typed = own.registry ?? positionals[0] ?? (await chooseRegistry(step, known));
  if (typed === undefined) return undefined;
  const address = await commandLineAddress(own, positionals, typed, known, common, context.cwd);
  const { input, inside: within, exact, picks } = address;
  let { resolved } = address;
  if (!resolved.declared) {
    const unknown = await undeclaredRegistry(input, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }

  let namespace = selectScope(input, resolved, picks, within);
  let { asked, named, partial } = selection(resolved, picks);
  // An address that says what to install is the whole answer; only a bare one is asked about.
  const complete = picks.select !== undefined || exact;
  const asking: Interaction = complete
    ? { ...step, blocked: step.blocked ?? { kind: "yes" } }
    : step;
  preparing(asking);

  const { source } = await read(step, context, resolved, partial, named, namespace);
  const short = shortForm(source, resolved, namespace, picks);
  if (short !== undefined) {
    resolved = short;
    namespace = undefined;
    ({ asked, named, partial } = selection(resolved, picks));
  }
  const { catalogAlias, entries } = entriesFor(source, resolved, partial, namespace);

  // An address the manifest already resolves keeps the alias it was declared
  // under; anything else is named after the source it came from.
  const alias = resolved.declared
    ? aliasFor(input, true, known, source)
    : (own.as ?? aliasFor(input, false, known, source));
  return {
    alias,
    known,
    input,
    within,
    resolved,
    asked,
    partial,
    asking,
    source,
    catalogAlias,
    entries,
  };
}

/**
 * Taking everything an address names is the address itself, not the whole
 * registry: `add acme/my-team --all` must not drag in every other team.
 */
function requestedRefs(
  resolved: Resolved,
  input: string,
  alias: string,
  within: string | undefined,
  select: readonly string[] | undefined,
): string[] {
  const whole = resolved.declared ? input : [alias, within].filter(Boolean).join("/");
  if (select === undefined) return [whole];
  return select.map((qualified) => {
    const address = `${alias}/${qualified}`;
    const leaf = qualified.split("/").at(-1);
    return resolved.version !== undefined && leaf === resolved.name
      ? `${address}@${resolved.version}`
      : address;
  });
}

async function addAddress(
  context: CommandContext,
  { positionals, common, own }: Parsed,
  adopt?: ReadonlySet<string>,
): Promise<void> {
  const step = interaction(context.printer, defaultIo(), common.yes);
  const opened = await openAddress(context, { positionals, common, own }, step);
  if (opened === undefined) {
    cancel(step);
    return;
  }
  const { known, input, within, resolved, asked, partial, asking, source, alias } = opened;
  const { catalogAlias, entries } = opened;

  const gathered = await gather(
    asking,
    asked,
    context.cwd,
    showable(resolved),
    entries,
    partial,
    catalogAlias,
    source.namespacePlugins,
  );
  if (gathered === undefined) {
    cancel(step);
    return;
  }
  const { choices, loaded } = gathered;

  // Trust is asked on a terminal however exactly the address says what to install: naming a
  // plugin is not agreeing to what it runs. Only `--yes` or no terminal leaves it to `--trust`.
  const trust = await trustFor(
    step,
    source,
    chosenEntries(choices.select, entries),
    own.trust ?? [],
    loaded.manifest.artifacts.flatMap((ref) => (ref.registry === alias ? (ref.trust ?? []) : [])),
  );

  const refs = requestedRefs(resolved, input, alias, within, choices.select);

  let approved = true;
  let introduced = false;
  let copied = false;
  let repinned: Repin[] = [];
  let { location, config } = source.declared;
  const result = await runPipeline(
    loaded.roots,
    // `--copy` and `--for` are recorded on the entries this adds, not applied to the whole scope.
    { ...asked, scope: choices.scope, targets: undefined, copy: false },
    context.printer,
    context.cwd,
    planReport(context.printer),
    (fresh) => {
      const { manifest } = fresh;
      let recorded: RegistrySource;
      ({ introduced, copied, recorded } = recordRegistry(fresh, alias, known, source, resolved));
      ({ location, config } = recorded);

      const narrowed = narrowedTargets(fresh, asked, choices.targets);

      repinned = declare(manifest.artifacts, refs, narrowed, choices.copy, trust, (ref) =>
        reached(fresh.lock, ref).at(0),
      );
      manifest.artifacts = manifest.artifacts.filter(
        (ref) => !coveredByWhole(ref, manifest.artifacts),
      );

      return {
        // Every other registry stays as the lock has it, so adding one skill
        // does not fetch and re-plan the whole scope.
        aliases: [alias],
        ...(adopt === undefined ? {} : { adopt }),
        // Naming something already locked is asking for its newest version again.
        moving: new Set(refs.flatMap((text) => reached(fresh.lock, parseRef(text)))),
        // A whole namespace still installs the rest when one member's name is taken.
        adding: new Set(
          refs.map(parseRef).flatMap((ref) => (ref.name === undefined ? [] : [formatAddress(ref)])),
        ),
        approve: async (plan, targets) => {
          approved = await confirmPlan(asking, plan, {
            verb: "Install",
            // The targets picked for this add, which an entry may narrow from the scope's.
            targets: choices.targets ?? targets,
            kinds: choices.kinds,
            targetTable: fresh.targetTable,
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

  // `--json` changes only what is printed, so the background job is still added.
  let jobId: string | undefined;
  if (result.applied !== undefined) {
    jobId = await reportAdded(context, {
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
  } else {
    // An applied add says it with its summary; a dry run has none.
    settleCollisions(context, result.plan);
  }
  if (context.printer.format === "json") {
    printAdded(
      context,
      { registry: alias, layout: source.layout, artifacts: refs, jobId },
      result,
      common.dryRun,
    );
    return;
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

function printAdded(
  context: CommandContext,
  added: {
    registry: string;
    layout: LayoutId | undefined;
    artifacts: readonly string[];
    jobId: string | undefined;
  },
  result: RunResult,
  dryRun: boolean,
): void {
  const { jobId, layout, ...named } = added;
  context.printer.json({
    ok: true,
    data: {
      ...named,
      ...(isReadOnlyLayout(layout) ? { layout } : {}),
      dependencies: result.plan.neededBy,
      ...outcome(result, dryRun),
      ...(jobId === undefined ? {} : { jobId }),
    },
  });
}

/**
 * What an applied add changed: the registry it introduced, then the plan's summary.
 * Returns the job that keeps a user scope install current, if there is one.
 */
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
): Promise<string | undefined> {
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
  settleCollisions(context, added.ran.plan);
  if (added.scope === "user" && added.autoUpdate) {
    return keepCurrent(context, alias, added.config, added.pinned);
  }
  return undefined;
}

type AddFlags = SourceFlags & {
  as?: string;
  registry?: string;
  "no-auto-update"?: boolean;
  trust?: string[];
  from?: string | undefined;
};

/**
 * Plugins this add may install although a target that loads them runs what they carry as you:
 * named with `--trust`, trusted by the manifest already, or agreed to here on a terminal.
 */
async function trustFor(
  step: Interaction,
  source: Probed,
  chosen: readonly Entry[],
  flagged: readonly string[],
  already: readonly string[],
): Promise<string[]> {
  const trust = flagged.map(sanitizeName);
  const held = new Set([...trust, ...already]);
  for (const entry of chosen) {
    if (entry.kind !== "plugin" || held.has(entry.name)) continue;
    const carries = source.carriesOf(entry);
    if (carries.length === 0) continue;
    if (await confirmTrust(step, entry.name, describeCarried(carries))) trust.push(entry.name);
  }
  return trust;
}

/** What an address selects: the names it carries, read the way `--select` would be. */
function selection(resolved: Resolved, picks: CommonOptions) {
  const asked: CommonOptions =
    picks.select !== undefined || resolved.name === undefined
      ? picks
      : { ...picks, select: [resolved.name] };
  return {
    asked,
    named: asked.select?.includes("*") === true ? undefined : asked.select,
    // Only one address is read on its own: a `--select` value may name a
    // namespace, which the catalog has to be read to recognize.
    partial: resolved.name !== undefined && picks.select === undefined,
  };
}

/**
 * `acme/pdf` names a namespace. When the registry has no namespace `pdf` but exactly one artifact
 * of that name, it names that artifact instead; the manifest records its full name.
 */
function shortForm(
  source: Probed,
  resolved: Resolved,
  namespace: string | undefined,
  picks: CommonOptions,
): Resolved | undefined {
  if (namespace === undefined || resolved.name !== undefined || picks.select !== undefined) {
    return undefined;
  }
  const entries = source.catalog.entries;
  const plugin = (entry: Entry) => entry.kind === "plugin" && entry.name === namespace;
  if (entries.some((entry) => entry.group === namespace || plugin(entry))) return undefined;
  const [only] = among(entries, resolved.alias ?? source.alias, { name: namespace });
  if (only === undefined) return undefined;
  return { ...resolved, name: only.name, namespace: only.group, kind: only.kind };
}

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
 * once and never rewritten, so a policy someone set stays set. Returns its id.
 */
async function keepCurrent(
  context: CommandContext,
  alias: string,
  config: Readonly<Record<string, string>>,
  pinned: boolean,
): Promise<string | undefined> {
  let jobId: string;
  try {
    jobId = await withDaemon((client) =>
      withFreshConfig(client, async (state) => {
        const account = state.accounts.find((item) => item.registry === alias);
        const watched = state.jobs.find(
          (job) =>
            job.account === account?.id &&
            job.steps.some((step) => step.root !== undefined && scopeFor(step.root) === "user"),
        );
        if (watched !== undefined) return watched.id;
        const { job } = await client.request("job.create", {
          expectedRevision: state.revision,
          root: userScopeDir(),
          scope: "user",
          registry: alias,
          config,
          declaredOnly: true,
        });
        return job.id;
      }),
    );
  } catch (error) {
    context.printer.warning(
      `Installed, but could not turn on background updates: ${(error as Error).message}`,
    );
    context.printer.hint(`Run \`aireg job add -g --registry ${alias}\` to try again.`);
    return undefined;
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
  return jobId;
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
  const wanted = selectTargets(loaded.manifest, loaded.targetTable, { ...common, targets: picked });
  const scope = selectTargets(loaded.manifest, loaded.targetTable, {
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
  /** Plugins the person trusts to run what they carry, recorded on each entry this adds. */
  trust: readonly string[],
  /** The lockfile's name for what a ref already installs, if anything. */
  installedAs: (ref: Ref) => string | undefined,
): Repin[] {
  const repinned: Repin[] = [];
  const declaredAt = new Map(artifacts.map((ref, index) => [formatAddress(ref), index]));
  for (const text of refs) {
    const already = declaredAt.get(formatAddress(parseRef(text)));
    const held = already === undefined ? undefined : artifacts[already];
    const ref = entryOf(text, held, { narrowed, copy, trust });
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
    if (changed(declared, ref)) artifacts[already] = ref;
  }
  return repinned;
}

/** The entry an add writes, keeping what the entry it replaces already said. */
function entryOf(
  text: string,
  held: Ref | undefined,
  how: { narrowed: string[] | "scope" | undefined; copy: boolean; trust: readonly string[] },
): Ref {
  const trust = [...new Set([...(held?.trust ?? []), ...how.trust])].sort();
  return {
    ...parseRef(text),
    targets: how.narrowed === "scope" ? undefined : (how.narrowed ?? held?.targets),
    ...(how.copy || held?.copy === true ? { copy: true } : {}),
    ...(trust.length === 0 ? {} : { trust }),
  };
}

function changed(declared: Ref, ref: Ref): boolean {
  return (
    formatRef(declared) !== formatRef(ref) ||
    declared.exclude !== undefined ||
    declared.targets?.join() !== ref.targets?.join() ||
    declared.trust?.join() !== ref.trust?.join() ||
    declared.copy !== ref.copy
  );
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
  const withheld = withheldAt(catalog.withheld, { ...resolved, group: resolved.namespace });
  if (withheld !== undefined) {
    spin?.stop();
    throw new AiregError(`${withheldMessage(withheld)}, so nothing was installed.`, {
      code: ErrorCode.Invalid,
      hint:
        withheld.status === "blocked"
          ? "Pin another version, or ask the registry's owner why this one is blocked."
          : `Pin the version, as in \`@${withheld.version}\`, to install it before its release.`,
    });
  }
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
  /** Its source installs each namespace as a plugin in the user scope. */
  wrapped: boolean,
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
  const { manifest, targetTable } = loaded;
  const chosen = chosenEntries(picked.addresses, all);
  let targets = common.targets;
  if (targets === undefined && interactive(step)) {
    const items = chosen.map((entry) => asSelected(entry, alias));
    const picked = await chooseTargets(
      step,
      targetTable,
      loaded.roots,
      manifest.targets,
      items,
      wrapped,
    );
    if (canceled(picked)) return undefined;
    targets = picked;
  }

  const kinds = [...new Set(chosen.map((entry) => entry.kind))];
  let copy = common.copy;
  if (
    !copy &&
    interactive(step) &&
    methodIsMeaningful(targetTable, targets ?? [], scope, cwd, kinds)
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

/** A catalog entry as the plan would place it, for showing where each target loads it from. */
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
  const plugin = all.some((candidate) => candidate.kind === "plugin" && candidate.name === word);
  if (entry !== undefined) {
    const address = [entry.group, entry.kind, entry.name].filter(Boolean).join("/");
    if (plugin && ref.name === undefined) refuseShared(word, address, entry.kind, alias);
    return ref.version === undefined ? address : `${address}@${ref.version}`;
  }
  return ref.name === undefined && (namespaces.has(word) || plugin) ? word : undefined;
}

/** A plugin and an artifact of the same name: either is a fair reading, so neither is taken. */
function refuseShared(word: string, address: string, kind: string, alias: string): never {
  throw new AiregError(
    `${quoted(word)} names both the plugin ${word} and the ${kind} ${address}.`,
    {
      code: ErrorCode.Usage,
      hint: `Add the whole plugin with \`aireg add ${alias}/${word}\`, or only the ${kind} with \`-s ${address}\`.`,
    },
  );
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

/**
 * A namespace address narrows the catalog, so `-s` cannot reach past it. A plugin's namespace
 * holds its parts, and the plugin itself, which sits in none.
 */
function inside(entries: readonly Entry[], namespace: string | undefined): readonly Entry[] {
  if (namespace === undefined) return entries;
  return entries.filter(
    (entry) => entry.group === namespace || (entry.kind === "plugin" && entry.name === namespace),
  );
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
