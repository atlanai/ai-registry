import { list as listOf, quoted } from "#adapter/text.ts";
import type { RunsOptions } from "#cli/commands/job/runs.ts";
import {
  DEFAULT_INTERVAL_SECONDS,
  isStepPolicy,
  STEP_POLICIES,
  type StepPolicy,
} from "#core/config/model.ts";
import { MINIMUM_INTERVAL_SECONDS } from "#core/config/parse-job.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { probeAddress, throughManifest } from "#engine/address/probe.ts";
import { qualify } from "#engine/address/qualify.ts";
import type { CommonOptions } from "#engine/options.ts";

export interface Own extends Record<string, unknown>, RunsOptions {
  account?: string;
  registry?: string;
  name?: string;
  interval?: string;
  pull?: string;
  publish?: string;
  delete?: string;
  adopt?: string;
  claim?: string;
  mode?: string;
  kind?: string;
  watch?: string[];
  to?: string;
}

export function interval(value: string | undefined): number {
  const text = value ?? String(DEFAULT_INTERVAL_SECONDS);
  const seconds = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < MINIMUM_INTERVAL_SECONDS) {
    throw new AiregError(
      `--interval must be a whole number of seconds, at least ${MINIMUM_INTERVAL_SECONDS}.`,
      {
        code: ErrorCode.Usage,
        hint: `Pass seconds, such as \`--interval ${DEFAULT_INTERVAL_SECONDS}\`.`,
      },
    );
  }
  return seconds;
}

/** Only what the flags asked for; each leaf step takes its own. */
export function policy(own: Own): Record<string, string> {
  const pull = stepPolicy(own.pull, "--pull");
  const publish = stepPolicy(own.publish, "--publish");
  const removal = stepPolicy(own.delete, "--delete");
  const adopt = stepPolicy(own.adopt, "--adopt");
  const claim = stepPolicy(own.claim, "--claim");
  return {
    ...(pull === undefined ? {} : { pull }),
    ...(publish === undefined ? {} : { publish }),
    ...(removal === undefined ? {} : { delete: removal }),
    ...(adopt === undefined ? {} : { adopt }),
    ...(claim === undefined ? {} : { claim }),
  };
}

function stepPolicy(value: string | undefined, flag: string): StepPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isStepPolicy(value))
    throw new AiregError(`${flag} takes ${listOf(STEP_POLICIES, "or")}, not ${quoted(value)}.`, {
      code: ErrorCode.Usage,
      hint: `Pass \`${flag} on\` to act, \`${flag} report\` to only say what it finds, or \`${flag} off\`.`,
    });
  return value;
}

/**
 * `-s` names inside the registry, each as the full address the manifest records, so a
 * bare name never reads as a registry of its own. Undefined without `-s` or with `*`.
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
    const addresses = qualify(common.select, alias, read.catalog.entries, false, alias);
    return addresses.map((address) => `${alias}/${address}`);
  } finally {
    await read.close();
  }
}
