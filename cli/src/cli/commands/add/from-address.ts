import { sanitizeName } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { confirmPlan, confirmTrust } from "#cli/prompt/confirm-plan.ts";
import { equivalent } from "#cli/prompt/equivalent.ts";
import { cancel, type Interaction, interaction, interactive } from "#cli/prompt/interaction.ts";
import { settleCollisions } from "#cli/render/collisions.ts";
import { planReport } from "#cli/render/plan.ts";
import { noteUserScope } from "#cli/render/where.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { coveredByWhole } from "#core/manifest/match.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { reached } from "#core/plan/acquire/lock-view.ts";
import { describeCarried } from "#core/plan/carries.ts";
import { formatAddress, parseRef } from "#core/ref.ts";
import type { Probed, Resolved } from "#engine/address/probe.ts";
import { run as runPipeline } from "#engine/install/pipeline.ts";
import { openAddress, showable } from "./address.ts";
import { chosenEntries, gather, shortened } from "./choose.ts";
import { declare, narrowedTargets, type Repin, recordRegistry } from "./declare.ts";
import type { Parsed } from "./options.ts";
import { printAdded, reportAdded } from "./render.ts";

export async function addAddress(
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
  // `--copy` and `--for` are recorded on the entries this adds, not applied to the whole scope.
  const result = await runPipeline(
    loaded.roots,
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

      // Other registries stay as locked, so one add does not re-plan the scope. Naming something
      // locked asks for its newest version; a namespace still installs the rest when a name is taken.
      return {
        aliases: [alias],
        ...(adopt === undefined ? {} : { adopt }),
        moving: new Set(refs.flatMap((text) => reached(fresh.lock, parseRef(text)))),
        adding: new Set(
          refs.map(parseRef).flatMap((ref) => (ref.name === undefined ? [] : [formatAddress(ref)])),
        ),
        approve: async (plan, targets) => {
          // The targets picked for this add, which an entry may narrow from the scope's.
          approved = await confirmPlan(asking, plan, {
            verb: "Install",
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
