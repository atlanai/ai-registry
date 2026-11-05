import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { plural, sanitizeName } from "#adapter/text.ts";
import {
  chooseArtifacts,
  chooseMethod,
  chooseScope,
  chooseTargets,
  methodIsMeaningful,
} from "#cli/prompt/choose.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { type Entry, withoutCoveredLeaves } from "#core/catalog/catalog.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Selected } from "#core/plan/model.ts";
import { MANIFEST_FILE, SCOPE_DIR, type Scope } from "#core/store/paths.ts";
import { qualify } from "#engine/address/qualify.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { locate, resolveScope } from "#engine/scope/locate.ts";

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

/** Gather missing choices; cancellation returns no choices. */
export async function gather(
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

/** Undefined when canceled. */
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
    return { addresses: qualify({ picks: common.select, shown, entries: all, partial, alias }) };
  }

  if (interactive(step)) {
    const picked = await chooseArtifacts(step, all, []);
    if (canceled(picked)) return undefined;
    return { addresses: qualify({ picks: picked, shown, entries: all, partial: false, alias }) };
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
  /** Undefined means the whole registry, matching the manifest shape. */
  addresses: string[] | undefined;
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

/** The entries a selection covers; every entry when the whole registry is taken. */
export function chosenEntries(
  addresses: readonly string[] | undefined,
  all: readonly Entry[],
): Entry[] {
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

/** The hint's addresses: the kind only where a namespace has two artifacts of one name. */
export function shortened(
  addresses: string[] | undefined,
  all: readonly Entry[],
): string[] | undefined {
  return addresses?.map((address) => {
    const [namespace, kind, name] = address.split("/");
    if (name === undefined || kind === undefined) return address;
    const same = all.filter((entry) => entry.group === namespace && entry.name === name);
    return same.length === 1 ? `${namespace}/${name}` : address;
  });
}
