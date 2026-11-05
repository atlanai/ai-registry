import { quoted, sanitizeName, withoutCredentials } from "#adapter/text.ts";
import { expandLocation, recordedLocation } from "#core/adapter/location.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import {
  formatAddress,
  formatRef,
  parseRef,
  type Ref,
  relativeTo,
  withExclusions,
} from "#core/ref.ts";
import { type Probed, type Resolved, rememberSource } from "#engine/address/probe.ts";
import { sameLocation } from "#engine/address/registries.ts";
import { selectTargets } from "#engine/install/targets.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Loaded, load } from "#engine/scope/load.ts";

/** Refuses an alias another address already holds. */
export function recordRegistry(
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

/**
 * Recorded on the entry only when they differ from the scope's, so a narrowed add
 * never unlinks anything else; picking exactly the scope's widens it back.
 */
export function narrowedTargets(
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

export interface Repin {
  name: string;
  version: string | undefined;
}

/**
 * Keyed by address, not the whole reference, so adding again at another version
 * re-pins the entry; a member a whole ref excludes is taken back into that ref.
 */
export function declare(
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

function changed(declared: Ref, ref: Ref): boolean {
  return (
    formatRef(declared) !== formatRef(ref) ||
    declared.exclude !== undefined ||
    declared.targets?.join() !== ref.targets?.join() ||
    declared.trust?.join() !== ref.trust?.join() ||
    declared.copy !== ref.copy
  );
}
