import { relative, resolve } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import type { PublishRelationship, PublishResult, Want } from "#adapter/index.ts";
import { isLocalPath } from "#adapter/paths.ts";
import { BUMPS, type Bump, compareVersion, parseVersion } from "#adapter/semver.ts";
import { list, plural, quoted } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import { type Interaction, interaction, interactive } from "#cli/prompt/flow.ts";
import { canceled, confirm, defaultIo, select, text } from "#cli/prompt/index.ts";
import { multiselect } from "#cli/prompt/multiselect.ts";
import { changeLines, changesJson } from "#cli/publish/changes.ts";
import {
  chooseTarget,
  dependsOnFor,
  exportWork,
  forTarget,
  inDependencyOrder,
  namesTarget,
  publishWants,
  type Skipped,
  takenBy,
} from "#cli/publish/exports.ts";
import { exportsOn, installedPaths } from "#cli/publish/reach.ts";
import {
  commitAndPush,
  type Destination,
  folderTo,
  heldUnlisted,
  namespacesIn,
  type Planned,
  type Published,
  parseTo,
  plan,
  readPublished,
  releaseSubject,
  writableRegistries,
} from "#cli/publish/target.ts";
import { changedSince, type Exported, edited, fromArgs, type Work } from "#cli/publish/work.ts";
import { chooseRegistry, knownIn, knownRegistries } from "#cli/registries.ts";
import { underHome } from "#cli/render/home.ts";
import { noteUserScope } from "#cli/render/where.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { digest } from "#core/fs/digest.ts";
import { gitIn } from "#core/git.ts";
import { type LockArtifact, writeLock } from "#core/lock.ts";
import {
  type Export,
  type Manifest,
  pinOf,
  type RegistrySource,
  unknownRegistry,
} from "#core/manifest.ts";
import type { Printer } from "#core/output.ts";
import { listedAt, type Placement } from "#core/plan/model.ts";
import { applyLocal } from "#engine/local.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load, withScope } from "#engine/pipeline.ts";
import { closeScan, type Scan, scan } from "#engine/scan.ts";
import { builtin, type CommandContext } from "./index.ts";

interface Own extends Record<string, unknown> {
  to?: string;
  bump?: string;
  message?: string;
  "changed-since"?: string;
}

/** What the change is, in the words a commit or a changelog would use. */
function subjectOf(items: readonly Planned[]): string {
  return releaseSubject(
    items.map((item) => ({
      name: item.work.name,
      version: item.version,
      first: item.from === undefined,
    })),
  );
}

function bumpOf(value: string | undefined): Bump | undefined {
  if (value === undefined) return undefined;
  if ((BUMPS as readonly string[]).includes(value)) return value as Bump;
  throw new AiregError(`Unknown --bump level ${quoted(value)}.`, {
    code: ErrorCode.Usage,
    hint: `Pass ${list(BUMPS, "or")}.`,
  });
}

/** With nothing named, the work edited here: all of it under `--yes`, a pick on a terminal. */
async function chooseWork(
  step: Interaction,
  loaded: Loaded,
  common: CommonOptions,
  cwd: string,
  keep: (found: Work[]) => Promise<Work[]>,
) {
  const found = await keep(await edited(loaded, common, cwd));
  // A dry run sends nothing, so listing everything is the answer to "what would go".
  if (found.length === 0 || common.yes || common.dryRun) return found;
  if (!interactive(step)) {
    throw new AiregError("`aireg publish` needs a path or an artifact name.", {
      code: ErrorCode.Usage,
      hint: `Name one, or pass \`--yes\` to publish everything edited here: ${list(found.map((w) => w.name))}.`,
    });
  }
  const picked = await multiselect(
    {
      message: "What should be published?",
      style: step.printer.errStyle,
      choices: found.map((work, index) => ({
        value: String(index),
        label: work.name,
        hint: work.home === undefined ? `${work.kind}, new` : `${work.kind}, edited here`,
      })),
      required: true,
    },
    step.io,
  );
  return canceled(picked) ? undefined : picked.map((index) => found[Number(index)] as Work);
}

/** `--to`, else where it was installed from, else asked; a script must say. */
async function destinationOf(
  step: Interaction,
  works: readonly Work[],
  known: Readonly<Record<string, RegistrySource>>,
  to: Destination | undefined,
  namespacesOf: (alias: string) => Promise<string[]>,
  saved: Destination | undefined,
): Promise<Map<Work, { registry: string; namespace: string }> | undefined> {
  const where = new Map<Work, { registry: string; namespace: string }>();
  const homeless: Work[] = [];
  for (const work of works) {
    if (to !== undefined) where.set(work, to);
    else if (work.home?.namespace !== undefined)
      where.set(work, { registry: work.home.registry, namespace: work.home.namespace });
    else if (saved !== undefined) where.set(work, saved);
    else homeless.push(work);
  }
  if (homeless.length === 0) return where;
  if (!interactive(step)) {
    throw new AiregError(`No registry to publish ${list(homeless.map((w) => w.name))} to.`, {
      code: ErrorCode.Usage,
      hint: "Name one: `aireg publish <path> --to <registry>/<namespace>`.",
    });
  }
  const registry = await chooseRegistry(step, known, {
    message: "Publish to which registry?",
    missing: "No registry is declared to publish to.",
    usage: (aliases) =>
      `Name one: \`aireg publish <path> --to <registry>/<namespace>\`, such as ${aliases}.`,
  });
  if (registry === undefined) return undefined;
  const namespaces = await namespacesOf(registry);
  if (namespaces.length === 0) {
    throw new AiregError(`${registry} has no namespace yet.`, {
      code: ErrorCode.NotFound,
      hint: `Name a new one: \`aireg publish <path> --to ${registry}/<namespace>\`.`,
    });
  }
  const namespace = await select<string>(
    {
      message: "Into which namespace?",
      style: step.printer.errStyle,
      initial: namespaces[0] as string,
      options: namespaces.map((name) => ({ value: name, label: name })),
    },
    step.io,
  );
  if (canceled(namespace)) return undefined;
  for (const work of homeless) where.set(work, { registry, namespace });
  return where;
}

function dependencyOf(edge: PublishRelationship): string {
  const at = edge.to.lastIndexOf("@");
  const name = edge.to.slice(0, at).split("/").at(-1);
  return `${name} ${edge.to.slice(at + 1)}`;
}

function describe(item: Planned): string[] {
  const address = `${item.namespace}/${item.work.kind}/${item.work.name}`;
  const edges = item.input.relationships ?? [];
  const needs = edges.length === 0 ? "" : `, depends on ${edges.map(dependencyOf).join(", ")}`;
  if (item.same) return [`  same    ${address}  ${item.version}, already published${needs}`];
  if (item.from === undefined) return [`  add     ${address}  ${item.version}${needs}`];
  const below = item.belowLatest ? " (below latest)" : "";
  return [
    `  update  ${address}  ${item.from} → ${item.version}${below}${needs}`,
    ...(item.changes === undefined ? [] : changeLines(item.changes)),
  ];
}

function describeSkip(skip: Skipped, namespace: string): string {
  return `  skip    ${namespace}/${skip.kind}/${skip.name}  ${skip.reason}`;
}

type Sending = { alias: string; item: Planned }[];

/** What `--json` says beside each artifact: whether anything was sent, where, and what was left out. */
interface Outcome {
  dryRun: boolean;
  /** Where exports go, from `--to` or `publish.to`; absent when each artifact goes where it came from. */
  to: Destination | undefined;
  skipped: readonly Skipped[];
}

function filesOf(item: Planned): { files?: string[] } {
  const { files } = item.input;
  return item.work.kind === "agent" && files.length > 1
    ? { files: files.map((file) => file.path) }
    : {};
}

/** Each artifact under `--json`: its versions, and where it went. */
function report(
  printer: Printer,
  planned: Sending,
  results: ReadonlyMap<string, PublishResult | undefined>,
  outcome: Outcome,
): void {
  if (printer.format !== "json") return;
  const { dryRun, to, skipped } = outcome;
  const target = to === undefined ? null : { registry: to.registry, namespace: to.namespace };
  const artifacts = planned.map(({ alias, item }) => {
    const result = results.get(alias);
    return {
      name: item.work.name,
      kind: item.work.kind,
      registry: alias,
      namespace: item.namespace,
      from: item.from ?? null,
      version: item.version,
      // Leaves out the version, so two dry runs agree exactly when the content does.
      digest: item.input.contentId,
      belowLatest: item.belowLatest,
      published: !item.same && results.has(alias) && result?.unchanged !== true,
      dependsOn: (item.input.relationships ?? []).map(({ to }) => ({ to })),
      ...filesOf(item),
      ...changesJson(item.changes),
    };
  });
  printer.json({ ok: true, data: { dryRun, target, artifacts, skipped } });
}

/** The edges an export carries into one target, given what this run plans for the others. */
type EdgesFor = (
  work: Work,
  target: { registry: string; namespace: string },
  published: Published,
  planned: (path: string) => Promise<Planned | undefined>,
) => Promise<PublishRelationship[] | undefined>;

/** Whether an existing changed artifact needs a version-bump choice rather than a fixed version. */
export function bumped(items: readonly Planned[]): boolean {
  return items.some(
    (item) => item.from !== undefined && !item.same && item.work.exported?.version === undefined,
  );
}

/** Planned at a patch first; asked how big only when something already published moved. */
async function planAll(
  step: Interaction,
  works: readonly Work[],
  where: Map<Work, { registry: string; namespace: string }>,
  open: (alias: string) => Promise<Published>,
  bump: Bump | undefined,
  exact: string | undefined,
  force: boolean,
  edgesFor: EdgesFor | undefined,
): Promise<Sending | undefined> {
  const at = (how: Bump) => {
    const pending = new Map<Work, Promise<Sending[number]>>();
    for (const work of works) {
      const target = where.get(work) as { registry: string; namespace: string };
      const planned = async (path: string) => {
        const other = works.find(
          (each) =>
            each.path === path &&
            where.get(each)?.registry === target.registry &&
            where.get(each)?.namespace === target.namespace,
        );
        return other === undefined ? undefined : (await pending.get(other))?.item;
      };
      const next = async () => {
        const published = await open(target.registry);
        const edges = await edgesFor?.(work, target, published, planned);
        return {
          alias: target.registry,
          item: await plan(work, published, target.namespace, how, exact, force, edges),
        };
      };
      pending.set(work, next());
    }
    return Promise.all(pending.values());
  };
  const planned = await at(bump ?? "patch");
  const moved = bumped(planned.map(({ item }) => item));
  if (bump !== undefined || exact !== undefined || !moved || !interactive(step)) return planned;
  const picked = await select<Bump>(
    {
      message: "How big a change is this?",
      style: step.printer.errStyle,
      initial: "patch",
      options: BUMPS.map((value) => ({ value, label: value })),
    },
    step.io,
  );
  return canceled(picked) ? undefined : at(picked);
}

/** The plan, then one question; what is already published is shown and never sent. */
async function review(
  context: CommandContext,
  step: Interaction,
  planned: Sending,
  open: (alias: string) => Promise<Published>,
  dryRun: boolean,
  asks: (alias: string) => Promise<boolean>,
  skipped: { into: string; namespace: string; skipped: readonly Skipped[] } | undefined,
): Promise<Sending | undefined> {
  const printer = context.printer;
  const lines: string[] = [];
  for (const alias of new Set(planned.map((entry) => entry.alias))) {
    const { location } = await open(alias);
    lines.push(
      location === alias ? underHome(alias) : `${alias}  ${printer.style.dim(underHome(location))}`,
    );
    for (const { item } of planned.filter((entry) => entry.alias === alias))
      lines.push(...describe(item));
    if (alias === skipped?.into)
      for (const skip of skipped.skipped) lines.push(describeSkip(skip, skipped.namespace));
  }
  const print = () => {
    for (const line of lines) printer.info(line);
  };
  const sending = planned.filter(({ item }) => !item.same);
  if (sending.length === 0) {
    print();
    printer.info(printer.style.dim("Nothing new to publish."));
    return undefined;
  }
  if (dryRun || !interactive(step)) {
    print();
    return dryRun ? undefined : sending;
  }
  // A source that asks why the change was made asks that instead; canceling it still sends nothing.
  const asking = await Promise.all([...new Set(sending.map((entry) => entry.alias))].map(asks));
  if (asking.every(Boolean)) {
    print();
    return sending;
  }
  // The plan is the question's body, so it reads as one step, as `add` and `remove` do.
  const proceed = await confirm(
    {
      message: `Publish ${plural(sending.length, "artifact")}?`,
      style: printer.errStyle,

      body: lines.map((line) => line.replace(/^ {2}/, "")),
    },
    step.io,
  );
  if (!canceled(proceed) && proceed) return sending;
  printer.info("Canceled. Nothing was published.");
  return undefined;
}

/** The command that sends this work into a clone of `alias` instead, naming it when there is one. */
function intoClone(
  works: readonly Work[],
  alias: string,
  to: Destination | undefined,
  cwd: string,
): string {
  const going = works.filter((work) => (to?.registry ?? work.home?.registry) === alias);
  const only = going.length === 1 ? going[0] : undefined;
  const namespace = to?.namespace ?? only?.home?.namespace ?? "<namespace>";
  const what = only === undefined ? "" : ` ${only.row ?? (relative(cwd, only.path) || ".")}`;
  return `aireg publish${what} --to <folder>/${namespace}`;
}

/** `--to` as a destination; a folder inside a git checkout is reported as one. */
async function destinationFrom(
  raw: string | undefined,
  cwd: string,
  known: Record<string, RegistrySource>,
): Promise<{ to: Destination | undefined; checkout: Checkout | undefined }> {
  if (raw === undefined) return { to: undefined, checkout: undefined };
  if (!isLocalPath(raw)) return { to: parseTo(raw), checkout: undefined };
  const folder = await folderTo(raw, cwd);
  known[folder.destination.registry] = folder.declared;
  const inGit = await gitIn(folder.declared.location, ["rev-parse", "--is-inside-work-tree"]);
  if (inGit.code !== 0) return { to: folder.destination, checkout: undefined };
  // Nothing in a git checkout reaches anyone until git pushes it. The `cd` there stays
  // short, from real paths on both sides, however --to was typed.
  const at = relative(canonical(cwd), canonical(folder.declared.location)) || ".";
  return { to: folder.destination, checkout: { registry: folder.destination.registry, at } };
}

/** A registry folder inside a git checkout, and where to `cd` to commit in it. */
interface Checkout {
  registry: string;
  at: string;
}

/** Publishes one registry's share of the work and says what happens next. */
async function sendTo(
  printer: CommandContext["printer"],
  step: Interaction,
  alias: string,
  items: Planned[],
  opened: Published,
  /** Where to `cd` to commit, when the registry folder is a git checkout. */
  options: { message: string | undefined; asked: boolean; checkout: string | undefined },
): Promise<PublishResult | undefined | "canceled"> {
  const { adapter, handle } = opened.source;
  if (options.message !== undefined && adapter.capabilities.messages !== true) {
    printer.hint(
      options.checkout !== undefined
        ? "A registry folder keeps no change message, so -m was not used. Put it in your git commit instead."
        : `${alias} keeps no change message, so -m was not used.`,
    );
  }
  let message = options.message ?? subjectOf(items);
  if (options.asked) {
    const typed = await text(
      {
        message: "What changed?",
        style: printer.errStyle,
        initial: message,
        hint: "Type what changed, or press Enter to use this message.",
      },
      step.io,
    );
    if (canceled(typed)) return "canceled";
    message = typed;
  }
  const published = await handle
    .publish?.(
      items.map((item) => item.input),
      { message, review: true },
    )
    .catch((error: unknown) => {
      throw heldUnlisted(error, alias, items);
    });
  const what = items.length === 1 ? items[0]?.work.name : plural(items.length, "artifact");
  printer.success(published?.summary ?? `Published ${what} to ${alias}.`);
  for (const note of published?.notes ?? []) printer.info(`  ${note}`);
  if (options.checkout !== undefined)
    printer.note("next", commitAndPush(message, options.checkout));
  else if (published?.summary === undefined) {
    printer.note(
      "when",
      `background jobs within ${DEFAULT_INTERVAL_WORDS}, projects on \`aireg update\``,
    );
  }
  return published;
}

function nameOne(works: Work[], to: Destination | undefined, explicit: boolean): void {
  if (to?.name === undefined) return;
  if (!explicit) {
    throw new AiregError("--to names one artifact, so it needs the path to publish.", {
      code: ErrorCode.Usage,
      hint: "Name it: `aireg publish <path> --to <registry>/<namespace>/<name>`.",
    });
  }
  if (works.length !== 1)
    throw new AiregError(
      `--to names one artifact, but ${plural(works.length, "artifact")} were given.`,
      {
        code: ErrorCode.Usage,
        hint: "Publish them one at a time, or leave the name off `--to`.",
      },
    );
  (works[0] as Work).name = to.name;
}

/** Where this run sends work, and what of it the manifest's exports keep from going there. */
interface Bound {
  works: Work[];
  skipped: Skipped[];
  to: Destination | undefined;
  checkout: Checkout | undefined;
  /** The `publish.to` target, as the manifest writes it. */
  target: string | undefined;
}

async function boundFor(
  works: Work[],
  manifest: Manifest,
  typed: string | undefined,
  given: { to: Destination | undefined; checkout: Checkout | undefined },
  known: Record<string, RegistrySource>,
  dirs: { base: string; cwd: string },
): Promise<Bound> {
  if (manifest.publish === undefined)
    return { ...forTarget(works, dirs.base), ...given, target: undefined };
  if (!works.some((work) => work.exported !== undefined))
    return { works, skipped: [], ...given, target: undefined };
  const { to } = given;
  const folder = typed !== undefined && isLocalPath(typed) ? to : undefined;
  const root = folder === undefined ? undefined : known[folder.registry]?.location;
  const target = chooseTarget(
    manifest.publish.to,
    typed,
    (listed) => to !== undefined && namesTarget(listed, to, root, dirs.base),
  );
  const chosen =
    to === undefined
      ? await destinationFrom(target, isLocalPath(target) ? dirs.base : dirs.cwd, known)
      : given;
  return { ...forTarget(works, dirs.base), ...chosen, target };
}

function edgesOf(
  loaded: Loaded,
  found: ReadonlyMap<string, Export> | undefined,
  known: Record<string, RegistrySource>,
  left: ReadonlySet<string>,
): EdgesFor | undefined {
  if (found === undefined) return undefined;
  return async (work, target, published, planned) =>
    work.exported === undefined
      ? undefined
      : dependsOnFor(work, {
          base: loaded.roots.base,
          left,
          manifest: loaded.manifest,
          lock: loaded.lock,
          known,
          target,
          published,
          planned,
        });
}

async function gather(
  step: Interaction,
  loaded: Loaded,
  common: CommonOptions,
  cwd: string,
  options: {
    paths: readonly string[];
    since: string | undefined;
    found: ReadonlyMap<string, Export> | undefined;
  },
): Promise<Work[] | undefined> {
  const { paths, since, found } = options;
  const keep = async (works: Work[]) =>
    since === undefined ? works : changedSince(works, since, cwd);

  const exported = found === undefined ? undefined : await exportWork(found, loaded.roots.base);
  const works =
    paths.length > 0
      ? await keep(await fromArgs(paths, loaded, cwd))
      : exported !== undefined
        ? await keep(exported)
        : await chooseWork(step, loaded, common, cwd, keep);
  for (const work of works ?? []) work.exported = found?.get(work.path);
  return works;
}

async function writableFirst(
  to: Destination | undefined,
  manifest: Manifest,
  known: Readonly<Record<string, RegistrySource>>,
  cwd: string,
): Promise<Record<string, RegistrySource> | undefined> {
  const planned = manifest.exports.length > 0 && manifest.publish !== undefined;
  return to === undefined && !planned ? writableRegistries(known, cwd) : undefined;
}

function refuseUndeclared(
  destination: Destination | undefined,
  known: Readonly<Record<string, RegistrySource>>,
  loaded: Loaded,
): void {
  if (destination === undefined || known[destination.registry] !== undefined) return;
  throw unknownRegistry(
    destination.registry,
    loaded.roots.scope,
    Object.keys(known),
    undefined,
    knownIn(loaded.roots.scope),
  );
}

function nothing(printer: Printer, outcome: Outcome): void {
  printer.info(printer.style.dim("Nothing to publish."));
  for (const skip of outcome.skipped) printer.info(describeSkip(skip, outcome.to?.namespace ?? ""));
  report(printer, [], new Map(), outcome);
}

function opener(
  known: Readonly<Record<string, RegistrySource>>,
  cwd: string,
  /** The command that sends this work into a clone of a registry instead. */
  how: (alias: string) => string,
  /** What this run asks each registry for, by its alias. */
  wants: ReadonlyMap<string, readonly Want[]>,
) {
  const opened = new Map<string, Published>();
  const open = async (alias: string): Promise<Published> => {
    const cached = opened.get(alias);
    if (cached !== undefined) return cached;
    const declared = known[alias] as RegistrySource;
    const read = await readPublished(alias, declared, cwd, wants.get(alias) ?? [], how(alias));
    opened.set(alias, read);
    return read;
  };
  const close = () => Promise.all([...opened.values()].map((entry) => entry.source.handle.close()));
  return { open, close };
}

async function savedDefault(
  known: Readonly<Record<string, RegistrySource>>,
): Promise<Destination | undefined> {
  const declared = (await readConfig()).defaults.namespace;
  const fallback = declared === undefined ? undefined : parseTo(declared);
  return fallback !== undefined && known[fallback.registry] !== undefined ? fallback : undefined;
}

async function reachExports(
  loaded: Loaded,
  printer: Printer,
): Promise<Map<string, Exported> | undefined> {
  const { manifest, roots, lock } = loaded;
  if (manifest.exports.length === 0) return undefined;
  const reached = await exportsOn(manifest, roots.base, installedPaths(lock, roots.base));
  for (const note of reached.notes) printer.info(note);
  for (const warning of reached.warnings) printer.warning(warning);
  return reached.found;
}

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common, own } = parse<Own>(context.argv, builtin("publish"));
  const printer = context.printer;
  const step = interaction(printer, defaultIo(), common.yes);
  const loaded = await load(common, context.cwd, "user");
  const known = { ...(await knownRegistries(common, context.cwd)) };
  const declaredOnly = (destination: Destination | undefined) =>
    refuseUndeclared(destination, known, loaded);
  const given = await destinationFrom(own.to, context.cwd, known);
  declaredOnly(given.to);
  const { manifest } = loaded;
  const base = loaded.roots.base;
  const early = await writableFirst(given.to, manifest, known, context.cwd);

  const found = await reachExports(loaded, printer);
  const chosen = await gather(step, loaded, common, context.cwd, {
    paths: positionals,
    since: own["changed-since"],
    found,
  });
  if (chosen === undefined) return printer.info("Canceled. Nothing was published.");
  const bound = await boundFor(chosen, manifest, own.to, given, known, { base, cwd: context.cwd });
  const { to, checkout, skipped, target } = bound;
  declaredOnly(to);
  const works = found === undefined ? bound.works : inDependencyOrder(bound.works, found, base);
  const targets =
    early ?? (to === undefined ? await writableRegistries(known, context.cwd) : known);
  if (works.length === 0) return nothing(printer, { dryRun: common.dryRun, to, skipped });
  nameOne(works, to, positionals.length > 0 || target === undefined);

  const how = (alias: string) => intoClone(works, alias, to, context.cwd);
  const namespacesOf = (alias: string) =>
    namespacesIn(alias, known[alias] as RegistrySource, context.cwd, how(alias));
  const where = await destinationOf(
    step,
    works,
    targets,
    to,
    namespacesOf,
    await savedDefault(known),
  );
  if (where === undefined) return printer.info("Canceled. Nothing was published.");
  const { open, close } = opener(known, context.cwd, how, await publishWants(works, where, base));
  try {
    const taken = await takenBy(
      works,
      async (work) => {
        const alias = (where.get(work) as Destination).registry;
        return { alias, adapter: (await open(alias)).source.adapter };
      },
      found,
      base,
    );
    for (const warning of taken.warnings) printer.warning(warning);
    const outcome = { dryRun: common.dryRun, to, skipped: [...skipped, ...taken.skipped] };
    if (taken.works.length === 0) return nothing(printer, outcome);

    const planned = await planAll(
      step,
      taken.works,
      where,
      open,
      bumpOf(own.bump),
      to?.version,
      common.force,
      edgesOf(loaded, found, known, taken.left),
    );
    if (planned === undefined) return printer.info("Canceled. Nothing was published.");
    // Only a person at a terminal is asked, and only by a source that records a reason.
    const asks = async (alias: string) =>
      interactive(step) &&
      own.message === undefined &&
      (await open(alias)).source.adapter.capabilities.messages === true;
    const skips =
      to === undefined
        ? undefined
        : { into: to.registry, namespace: to.namespace, skipped: outcome.skipped };
    const sending = await review(context, step, planned, open, common.dryRun, asks, skips);
    if (sending === undefined) return report(printer, planned, new Map(), outcome);

    const results = new Map<string, PublishResult | undefined>();
    for (const alias of new Set(sending.map((entry) => entry.alias))) {
      const items = sending.filter((entry) => entry.alias === alias).map(({ item }) => item);
      const sent = await sendTo(printer, step, alias, items, await open(alias), {
        message: own.message,
        asked: await asks(alias),
        checkout: alias === checkout?.registry ? checkout.at : undefined,
      });
      if (sent === "canceled") return printer.info("Canceled. Nothing was published.");
      results.set(alias, sent);
    }
    await follow(
      context,
      loaded,
      common,
      sending.map(({ item }) => item),
    );
    report(printer, planned, results, { ...outcome, dryRun: false });
    // A registry folder is not your user scope; an installed copy it sent from is.
    if (
      !isLocalPath(own.to ?? target ?? "") ||
      sending.some(({ item }) => item.work.row !== undefined)
    ) {
      noteUserScope(printer, common.scope, context.cwd);
    }
  } finally {
    await close();
  }
}

/**
 * An installed copy that was published holds exactly what landed, so its row is
 * restated from the source. A pinned row is left, or the pin would undo the edit.
 */
async function follow(
  context: CommandContext,
  loaded: Loaded,
  common: CommonOptions,
  sent: readonly Planned[],
) {
  const rows = new Map<string, string>();
  for (const item of sent) {
    const row = item.work.row;
    const entry = row === undefined ? undefined : loaded.lock.artifacts[row];
    if (row === undefined || entry === undefined) continue;
    const pinned = pinOf(loaded.manifest, entry);
    if (pinned === undefined) rows.set(row, item.version);
    else
      context.printer.hint(
        `${row} stays at ${pinned} here because the manifest pins it. Change the pin to ${item.version} to install what you published.`,
      );
  }
  if (rows.size === 0) return;
  await withScope(loaded.roots, async (fresh) => {
    const found = await scan(fresh, common, {
      credentials: await credentialsForManifest(fresh.manifest.registries, context.cwd),
    });
    try {
      const served = new Set(
        [...rows]
          .filter(([row, version]) => moved(found, fresh.lock.artifacts[row], version))
          .map(([row]) => row),
      );
      for (const [row, version] of rows) {
        const entry = fresh.lock.artifacts[row];
        if (served.has(row) || entry === undefined) continue;
        // What was sent is what is on disk, so the copy stops reading as an edit.
        entry.digest = await digest(resolve(fresh.roots.base, entry.path));
        const next = entry.origin === undefined ? "`aireg update`" : "`aireg sync`";
        // Moved past the lock but not to what was sent, as after `--force` into a clone.
        const other = moved(found, entry) ? head(found, entry)?.version : undefined;
        if (other === undefined) {
          context.printer.hint(
            `The registry does not serve ${row} yet, so the copy here was left as it is. Run ${next} once it does.`,
          );
        } else {
          context.printer.warning(
            `The registry serves ${row} ${other}, not the ${version} you published, so the copy here was left as it is. Run ${next} once it serves ${version}; before that it would replace your copy with ${other}.`,
          );
        }
      }
      if (served.size > 0) await applyLocal(fresh, common, found, served, served, true, () => {});
      else await writeLock(fresh.roots, fresh.lock);
    } finally {
      await closeScan(found);
    }
  });
}

/**
 * A backend may hold an upload for review. Until upstream serves something else, restating
 * the row from it would overwrite the copy just sent, or delete it when nothing is served.
 */
export function moved(
  found: Scan,
  entry: LockArtifact | undefined,
  /** The version just sent; an older head is someone else's, as after `--force` into a clone. */
  sent?: string,
): boolean {
  const now = entry === undefined ? undefined : head(found, entry);
  return (
    entry !== undefined &&
    now !== undefined &&
    (now.contentId !== entry.content || now.version !== entry.version) &&
    !older(now.version, sent)
  );
}

/** What the registry serves at the row's address now. */
function head(found: Scan, entry: LockArtifact): Placement | undefined {
  const acquired = found.acquired.find((item) => item.alias === entry.registry);
  const at = acquired === undefined ? undefined : listedAt(entry, acquired.catalog.entries);
  return at === undefined ? undefined : acquired?.placements.get(at);
}

function older(served: string | undefined, sent: string | undefined): boolean {
  const left = served === undefined ? undefined : parseVersion(served);
  const right = sent === undefined ? undefined : parseVersion(sent);
  return left !== undefined && right !== undefined && compareVersion(left, right) < 0;
}
