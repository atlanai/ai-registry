import type { PublishResult } from "#adapter/index.ts";
import { isLocalPath } from "#adapter/paths.ts";
import { gather, reachExports } from "#cli/commands/publish/choose.ts";
import {
  boundFor,
  destinationFrom,
  destinationOf,
  intoClone,
  nameOne,
  refuseUndeclared,
  savedDefault,
  writableFirst,
} from "#cli/commands/publish/destination.ts";
import { follow } from "#cli/commands/publish/follow.ts";
import { bumpOf, type Own } from "#cli/commands/publish/options.ts";
import { edgesOf, opener, planAll } from "#cli/commands/publish/plan.ts";
import { nothing, report } from "#cli/commands/publish/render.ts";
import { review } from "#cli/commands/publish/review.ts";
import { sendTo } from "#cli/commands/publish/send.ts";
import { PUBLISH_COMMAND } from "#cli/commands/publish/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { interaction, interactive } from "#cli/prompt/interaction.ts";
import { noteUserScope } from "#cli/render/where.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { knownRegistries } from "#engine/address/registries.ts";
import { inDependencyOrder, publishWants, takenBy } from "#engine/publish/exports.ts";
import { type Destination, namespacesIn, writableRegistries } from "#engine/publish/target.ts";
import { load } from "#engine/scope/load.ts";
import type { CommandContext } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common, own } = parse<Own>(context.argv, PUBLISH_COMMAND);
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
    namespacesIn(
      alias,
      known[alias] as RegistrySource,
      Object.keys(known),
      context.cwd,
      how(alias),
    );
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
