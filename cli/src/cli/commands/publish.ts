import { relative, resolve } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import type { PublishResult } from "#adapter/index.ts";
import { isLocalPath } from "#adapter/paths.ts";
import { BUMPS, type Bump } from "#adapter/semver.ts";
import { list, plural, quoted } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import { type Interaction, interaction, interactive } from "#cli/prompt/flow.ts";
import { canceled, confirm, defaultIo, select, text } from "#cli/prompt/index.ts";
import { multiselect } from "#cli/prompt/multiselect.ts";
import {
  commitAndPush,
  type Destination,
  folderTo,
  type Planned,
  type Published,
  parseTo,
  plan,
  readPublished,
  releaseSubject,
  writableRegistries,
} from "#cli/publish/target.ts";
import { changedSince, edited, fromArgs, type Work } from "#cli/publish/work.ts";
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
import { pinOf, type RegistrySource, unknownRegistry } from "#core/manifest.ts";
import type { Printer } from "#core/output.ts";
import { listedAt } from "#core/plan/model.ts";
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
  open: (alias: string) => Promise<Published>,
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
  const { namespaces } = await open(registry);
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

function describe(item: Planned): string {
  const address = `${item.namespace}/${item.work.kind}/${item.work.name}`;
  if (item.same) return `  same    ${address}  ${item.version}, already published`;
  if (item.from === undefined) return `  add     ${address}  ${item.version}`;
  return `  update  ${address}  ${item.from} → ${item.version}`;
}

type Sending = { alias: string; item: Planned }[];

/** Each artifact under `--json`: its versions, and where it went. */
function report(
  printer: Printer,
  planned: Sending,
  results: ReadonlyMap<string, PublishResult | undefined>,
  dryRun: boolean,
): void {
  if (printer.format !== "json") return;
  const artifacts = planned.map(({ alias, item }) => {
    const result = results.get(alias);
    return {
      name: item.work.name,
      kind: item.work.kind,
      registry: alias,
      namespace: item.namespace,
      from: item.from ?? null,
      version: item.version,
      published: !item.same && results.has(alias) && result?.unchanged !== true,
    };
  });
  printer.json({ ok: true, data: { dryRun, artifacts } });
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
): Promise<Sending | undefined> {
  const at = (how: Bump) =>
    Promise.all(
      works.map(async (work) => {
        const target = where.get(work) as { registry: string; namespace: string };
        const published = await open(target.registry);
        return {
          alias: target.registry,
          item: await plan(work, published, target.namespace, how, exact, force),
        };
      }),
    );
  const planned = await at(bump ?? "patch");
  const moved = planned.some(({ item }) => item.from !== undefined && !item.same);
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
): Promise<Sending | undefined> {
  const printer = context.printer;
  const lines: string[] = [];
  for (const alias of new Set(planned.map((entry) => entry.alias))) {
    const { location } = await open(alias);
    lines.push(
      location === alias ? underHome(alias) : `${alias}  ${printer.style.dim(underHome(location))}`,
    );
    for (const { item } of planned.filter((entry) => entry.alias === alias))
      lines.push(describe(item));
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
      body: lines.map((line) => line.trimStart()),
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
  const published = await handle.publish?.(
    items.map((item) => item.input),
    { message, review: true },
  );
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

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common, own } = parse<Own>(context.argv, builtin("publish"));
  const printer = context.printer;
  const step = interaction(printer, defaultIo(), common.yes);
  const loaded = await load(common, context.cwd, "user");
  const known = { ...(await knownRegistries(common, context.cwd)) };
  const { to, checkout } = await destinationFrom(own.to, context.cwd, known);
  if (to !== undefined && known[to.registry] === undefined) {
    throw unknownRegistry(
      to.registry,
      loaded.roots.scope,
      Object.keys(known),
      undefined,
      knownIn(loaded.roots.scope),
    );
  }
  const targets = to === undefined ? await writableRegistries(known, context.cwd) : known;

  const since = own["changed-since"];
  const keep = async (found: Work[]) =>
    since === undefined ? found : changedSince(found, since, context.cwd);
  const works =
    positionals.length > 0
      ? await keep(await fromArgs(positionals, loaded, context.cwd))
      : await chooseWork(step, loaded, common, context.cwd, keep);
  if (works === undefined) return printer.info("Canceled. Nothing was published.");
  if (works.length === 0) {
    printer.info(printer.style.dim("Nothing to publish."));
    return report(printer, [], new Map(), common.dryRun);
  }
  if (to?.name !== undefined) {
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

  const opened = new Map<string, Published>();
  const open = async (alias: string): Promise<Published> => {
    const cached = opened.get(alias);
    if (cached !== undefined) return cached;
    const read = await readPublished(
      alias,
      known[alias] as RegistrySource,
      context.cwd,
      intoClone(works, alias, to, context.cwd),
    );
    opened.set(alias, read);
    return read;
  };
  try {
    // Your own default for new work that names no destination. It spans every
    // project, so one that does not declare its registry simply has no default.
    const declared = (await readConfig()).defaults.namespace;
    const fallback = declared === undefined ? undefined : parseTo(declared);
    const saved =
      fallback !== undefined && known[fallback.registry] !== undefined ? fallback : undefined;
    const where = await destinationOf(step, works, targets, to, open, saved);
    if (where === undefined) return printer.info("Canceled. Nothing was published.");

    const planned = await planAll(
      step,
      works,
      where,
      open,
      bumpOf(own.bump),
      to?.version,
      common.force,
    );
    if (planned === undefined) return printer.info("Canceled. Nothing was published.");
    // Only a person at a terminal is asked, and only by a source that records a reason.
    const asks = async (alias: string) =>
      interactive(step) &&
      own.message === undefined &&
      (await open(alias)).source.adapter.capabilities.messages === true;
    const sending = await review(context, step, planned, open, common.dryRun, asks);
    if (sending === undefined) return report(printer, planned, new Map(), common.dryRun);

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
    report(printer, planned, results, false);
    // A registry folder is not your user scope; an installed copy it sent from is.
    const folder = own.to !== undefined && isLocalPath(own.to);
    if (!folder || sending.some(({ item }) => item.work.row !== undefined)) {
      noteUserScope(printer, common.scope, context.cwd);
    }
  } finally {
    await Promise.all([...opened.values()].map((entry) => entry.source.handle.close()));
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
  const rows = new Set<string>();
  for (const item of sent) {
    const row = item.work.row;
    const entry = row === undefined ? undefined : loaded.lock.artifacts[row];
    if (row === undefined || entry === undefined) continue;
    const pinned = pinOf(loaded.manifest, entry);
    if (pinned === undefined) rows.add(row);
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
      const served = new Set([...rows].filter((row) => moved(found, fresh.lock.artifacts[row])));
      for (const row of rows) {
        const entry = fresh.lock.artifacts[row];
        if (served.has(row) || entry === undefined) continue;
        // What was sent is what is on disk, so the copy stops reading as an edit.
        entry.digest = await digest(resolve(fresh.roots.base, entry.path));
        context.printer.hint(
          `The registry does not serve ${row} yet, so the copy here was left as it is. Run ${
            entry.origin === undefined ? "`aireg update`" : "`aireg sync`"
          } once it does.`,
        );
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
export function moved(found: Scan, entry: LockArtifact | undefined): boolean {
  if (entry === undefined) return false;
  const acquired = found.acquired.find((item) => item.alias === entry.registry);
  const at = acquired === undefined ? undefined : listedAt(entry, acquired.catalog.entries);
  const now = at === undefined ? undefined : acquired?.placements.get(at);
  return now !== undefined && (now.contentId !== entry.content || now.version !== entry.version);
}
