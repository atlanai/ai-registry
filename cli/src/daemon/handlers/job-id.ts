import { basename } from "node:path";
import { quoted, sanitizeName } from "#adapter/text.ts";
import type { Account, Job, RegistryConfig } from "#core/config/model.ts";
import { canonical } from "#core/fs/realpath.ts";
import type { Scope } from "#core/store/paths.ts";
import { invalidParams } from "#daemon/rpc/errors.ts";
import * as inputs from "./params.ts";

/**
 * One job per registry and folder, so a second project gets its own job rather
 * than taking over the first's. The first keeps the plain id.
 */
export function skillsJobId(
  config: RegistryConfig,
  params: Record<string, unknown>,
  account: Account,
  alias: string,
  root: string,
  scope: Scope,
): string {
  const here = canonical(root);
  const existing = config.jobs.find((job) => {
    const at = rootOf(job);
    return job.account === account.id && at !== undefined && canonical(at) === here;
  });
  if (params.name === undefined) {
    return existing?.id ?? nextFree(config, alias, scope === "user" ? "user" : basename(here));
  }
  const id = inputs.jobId(params, "name");
  if (existing !== undefined && existing.id !== id) {
    throw invalidParams(
      `${root} already syncs with ${alias} as job ${existing.id}. Leave out --name to update that job, or remove it first with \`aireg job remove ${existing.id}\`.`,
    );
  }
  const taken = config.jobs.find((job) => job.id === id);
  if (taken !== undefined && taken !== existing) {
    throw invalidParams(`Job ${quoted(id)} already exists. Pass another --name.`);
  }
  return id;
}

function rootOf(job: Job): string | undefined {
  return job.steps.find((step) => step.root !== undefined)?.root;
}

/** The plain id while it is free, then one that names the folder. */
function nextFree(config: RegistryConfig, alias: string, folder: string): string {
  const used = new Set(config.jobs.map((job) => job.id));
  const plain = productJobId("skills", alias);
  if (!used.has(plain)) return plain;
  // Short enough that the id, with a counter, stays within 64 characters.
  const base = productJobId("skills", `${alias}-${folder}`.slice(0, 48));
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

function productJobId(kind: string, label: string): string {
  const id = `job_${kind}_${sanitizeName(label)}`;
  if (!inputs.JOB_ID.test(id)) {
    throw invalidParams(`Cannot make a job id from ${quoted(label)}. Name the job with --name.`);
  }
  return id;
}

/** One job per account per contributed kind, so aireg names none of them. */
export function contributedJobId(
  config: RegistryConfig,
  params: Record<string, unknown>,
  account: Account,
  kind: string,
): string {
  const existing = config.jobs.find(
    (job) => job.account === account.id && job.steps.some((step) => step.kind === kind),
  );
  const id =
    params.name === undefined && existing !== undefined
      ? existing.id
      : named(params, productJobId(kind, account.registry));
  if (existing !== undefined && existing.id !== id) {
    throw invalidParams(
      `${account.registry} already has a ${kind} job, ${existing.id}. Leave out --name to update it.`,
    );
  }
  return id;
}

function named(params: Record<string, unknown>, product: string): string {
  return params.name === undefined ? product : inputs.jobId(params, "name");
}
