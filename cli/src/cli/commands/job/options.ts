import type { RunsOptions } from "#cli/commands/job/runs.ts";
import type { StepPolicy } from "#core/config/model.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import type { RunMode } from "#core/run/model.ts";
import { probeAddress, throughManifest } from "#engine/address/probe.ts";
import { qualify } from "#engine/address/qualify.ts";
import type { CommonOptions } from "#engine/options.ts";

export interface Own extends Record<string, unknown>, RunsOptions {
  account?: string;
  registry?: string;
  name?: string;
  interval?: number;
  pull?: StepPolicy;
  publish?: StepPolicy;
  delete?: StepPolicy;
  adopt?: StepPolicy;
  claim?: StepPolicy;
  mode?: RunMode;
  kind?: string;
  watch?: string[];
  to?: string;
}

export interface JobOptions {
  argument: string | undefined;
  own: Own;
  common: CommonOptions;
}

/** Only what the flags asked for; each leaf step takes its own. */
export function policy(own: Own): Record<string, StepPolicy> {
  const chosen = {
    pull: own.pull,
    publish: own.publish,
    delete: own.delete,
    adopt: own.adopt,
    claim: own.claim,
  };
  return Object.fromEntries(
    Object.entries(chosen).filter((entry): entry is [string, StepPolicy] => entry[1] !== undefined),
  );
}

/**
 * Each `-s` name becomes the full address the manifest records, so a bare name never
 * reads as a registry of its own. Undefined without `-s` or with `*`.
 */
export async function refsFrom(
  common: CommonOptions,
  alias: string,
  registries: Readonly<Record<string, RegistrySource>>,
  base: string,
): Promise<string[] | undefined> {
  if (common.select === undefined || common.select.includes("*")) return undefined;
  const read = await probeAddress(throughManifest(alias, registries, {}), base, []);
  try {
    const addresses = qualify({
      picks: common.select,
      shown: alias,
      entries: read.catalog.entries,
      partial: false,
      alias,
    });
    return addresses.map((address) => `${alias}/${address}`);
  } finally {
    await read.close();
  }
}
