import { AccountService } from "#accounts/service.ts";
import { messageOf } from "#adapter/errors.ts";
import { expandHome } from "#adapter/paths.ts";
import { list, quoted } from "#adapter/text.ts";
import { canonicalConfig, type SourceConfig } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { unwatchCommand } from "#core/config/jobs.ts";
import {
  type Account,
  DEFAULT_INTERVAL_SECONDS,
  type Job,
  type RegistryConfig,
  type Step,
} from "#core/config/model.ts";
import { readConfig, writeConfig } from "#core/config/repository.ts";
import { tokenVariable } from "#core/env.ts";
import { ErrorCode } from "#core/errors.ts";
import { stepContribution, stepOn } from "#core/host/load.ts";
import { withLease } from "#core/lease/lease.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import { coveredByWhole } from "#core/manifest/match.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { readManifest, writeManifest } from "#core/manifest/repository.ts";
import { formatAddress, formatRef, parseRef, type Ref } from "#core/ref.ts";
import { type Roots, roots, type Scope, scopeFor } from "#core/store/paths.ts";
import type { SyncPolicy } from "#core/sync/policy.ts";
import { OPTIONAL_AXES } from "#core/sync/policy.ts";
import { DEFAULT_TARGETS } from "#core/target/ids.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ProtocolError } from "#daemon/rpc/protocol.ts";
import { forgetOrigins } from "#engine/sync/origins.ts";
import { FOREGROUND_POLICY } from "#engine/sync/work.ts";
import { contributedJobId, skillsJobId } from "./job-id.ts";
import * as inputs from "./params.ts";
import { committed, staleSettings } from "./settings-write.ts";

/** Every job names an account; the credential on it is what may be absent. */
export function accountOf(config: RegistryConfig, job: Job): Account {
  return accountFor(config, job.account);
}

function accountFor(config: RegistryConfig, accountId: string): Account {
  const account = config.accounts.find(({ id }) => id === accountId);
  if (account === undefined) {
    throw new ProtocolError(RpcErrorCode.NotFound, `No account named ${quoted(accountId)}.`);
  }
  return account;
}

/** For methods that sync artifacts: a job with no rooted step syncs none. */
export function artifactsJobFor(config: RegistryConfig, jobId: string): Job {
  const job = jobFor(config, jobId);
  if (!job.steps.some((step) => step.root !== undefined)) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `Job ${quoted(jobId)} does not sync a project or your user scope.`,
    );
  }
  return job;
}

function jobFor(config: RegistryConfig, jobId: string): Job {
  const job = config.jobs.find(({ id }) => id === jobId);
  if (job === undefined) {
    throw new ProtocolError(RpcErrorCode.NotFound, `No job named ${quoted(jobId)}.`);
  }
  return job;
}

export async function createJob(
  raw: unknown,
  /** The caller's connection: a client that goes away stops waiting for the lease. */
  signal?: AbortSignal,
): Promise<{ config: RegistryConfig; job: Job }> {
  const params = inputs.object(raw);
  const type = adapterType(params);
  if (type !== undefined) return createAdapterJob(params, type);
  const expectedRevision = inputs.integer(params, "expectedRevision");
  const config = await readConfig();
  if (config.revision !== expectedRevision) {
    throw staleSettings(config.revision);
  }
  const alias = inputs.text(params, "registry");
  const root = inputs.absolutePath(params, "root");
  const scope: Scope = inputs.scope(params, "scope", "project");
  const refs = (inputs.optionalNames(params, "refs") ?? []).map((ref) => parseRef(ref));
  const foreign = refs.find((ref) => ref.registry !== alias);
  if (foreign !== undefined) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `${quoted(formatRef(foreign))} is not an artifact of ${quoted(alias)}: name it as ${alias}/<namespace>/<kind>/<name>.`,
    );
  }
  const sourceConfig = canonicalConfig(inputs.sourceConfig(params, "config"));
  const location = inputs.optionalText(params, "address");
  const adapter = inputs.optionalText(params, "adapter");

  const scopeRoots = roots(scope, root);
  const manifest = await readManifest(scopeRoots.manifest);
  const declared = manifest.registries[alias];
  await declareForAccounts(
    alias,
    declared ?? (location === undefined ? undefined : { location, adapter, config: sourceConfig }),
    scopeRoots.base,
  );
  const account = await bindAccount(config, alias);
  // adopt() writes the account first; saving the job against the caller's
  // snapshot then fails as stale. Use the revision that write left.
  const latest = await readConfig();
  const id = skillsJobId(latest, params, account, alias, root, scope);
  // A manifest that already names some of this registry's artifacts is not widened to all of
  // them: that would subscribe the job to the whole catalog behind the caller's back.
  const already = (await readManifest(scopeRoots.manifest)).artifacts.some(
    (ref) => ref.registry === alias,
  );
  const whole =
    already || params.declaredOnly === true ? [] : [{ registry: alias, path: [] as string[] }];
  const wanted = refs.length > 0 ? refs : whole;

  // `writeManifest` has no revision of its own; the CLI edits it under this
  // same lease, which is what stops the two losing each other's edit.
  await withLease(scopeRoots, { wait: true, ...(signal === undefined ? {} : { signal }) }, () =>
    declareRegistry(scopeRoots, alias, location, adapter, sourceConfig, wanted),
  );
  const origins = originsStep(
    params,
    latest.jobs.find((item) => item.id === id),
    scope,
  );
  // A new job starts from what a sync run by hand does; folders it watches are there to publish.
  const policy = inputs.syncPolicy(
    params,
    "policy",
    origins === undefined ? FOREGROUND_POLICY : { ...FOREGROUND_POLICY, publish: "on" },
  );
  const job: Job = {
    id,
    account: account.id,
    schedule: {
      every: inputs.intervalSeconds(params, "intervalSeconds", DEFAULT_INTERVAL_SECONDS),
      enabled: inputs.optionalFlag(params, "enabled", true),
    },
    steps: [
      ...(origins === undefined ? [] : [origins]),
      {
        name: "pull",
        kind: "pull",
        needs: origins === undefined ? [] : ["origins"],
        root,
        select: [],
        policy: policy.pull,
        extra: {},
      },
      {
        name: "publish",
        kind: "publish",
        needs: ["pull"],
        root,
        select: [],
        policy: policy.publish,
        extra: {},
      },
      {
        name: "prune",
        kind: "prune",
        needs: ["pull"],
        root,
        select: [],
        policy: policy.delete,
        extra: {},
      },
      ...optionalSteps(policy, root),
    ],
  };
  return { config: await saveJob(job, latest.revision), job };
}

function adapterType(params: Record<string, unknown>): string | undefined {
  const value = params.type ?? params.kind;
  if (typeof value !== "string" || value === "" || value === "artifacts") return undefined;
  return value;
}

/** Config only: an adapter-contributed type owns no scope tree. */
async function createAdapterJob(
  params: Record<string, unknown>,
  type: string,
): Promise<{ config: RegistryConfig; job: Job }> {
  const expectedRevision = inputs.integer(params, "expectedRevision");
  const config = await readConfig();
  const account = accountFor(config, inputs.text(params, "account"));
  let handler = await stepContribution(type);
  try {
    const resolved = await new AccountService().resolve(account);
    handler = stepOn(resolved.adapter, type) ?? handler;
  } catch {
    // The job still runs if any installed adapter registered this type.
  }
  if (handler === undefined) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `No installed adapter runs ${quoted(type)} jobs. Install one with \`aireg adapter install\`.`,
    );
  }
  // An adapter contributes a step kind, so a job for it is one step with the
  // fields that kind names; aireg stores them without reading them.
  const {
    id: _id,
    account: _account,
    type: _type,
    kind: _kind,
    expectedRevision: _revision,
    enabled: _enabled,
    name,
    intervalSeconds: _interval,
    ...extra
  } = params;
  const job: Job = {
    id: contributedJobId(config, params, account, type),
    ...(typeof name === "string" ? { name } : {}),
    account: account.id,
    schedule: {
      every: inputs.intervalSeconds(params, "intervalSeconds", DEFAULT_INTERVAL_SECONDS),
      enabled: inputs.optionalFlag(params, "enabled", true),
    },
    steps: [
      {
        name: type,
        kind: type,
        needs: [],
        select: [],
        policy: "on",
        extra: Object.freeze(extra),
      },
    ],
  };
  return { config: await saveJob(job, expectedRevision), job };
}

interface Watch {
  root: string;
  registry: string;
  folder: string;
}

async function saveJob(job: Job, expectedRevision: number): Promise<RegistryConfig> {
  const config = await readConfig();
  const jobs = [...config.jobs.filter(({ id }) => id !== job.id), job];
  const saved = await committed(() => writeConfig({ ...config, jobs }, expectedRevision));
  await forgetUnwatched(config.jobs, jobs);
  return saved;
}

/** A folder no job watches any more takes the copies aireg kept of it out of its scope. */
async function forgetUnwatched(before: readonly Job[], after: readonly Job[]): Promise<void> {
  const key = (watch: Watch) => JSON.stringify([watch.root, watch.registry, watch.folder]);
  const still = new Set(watches(after).map(key));
  const gone = new Map<string, { root: string; registry: string; folders: string[] }>();
  for (const watch of watches(before)) {
    if (still.has(key(watch))) continue;
    const at = JSON.stringify([watch.root, watch.registry]);
    const group = gone.get(at) ?? { root: watch.root, registry: watch.registry, folders: [] };
    group.folders.push(watch.folder);
    gone.set(at, group);
  }
  for (const { root, registry, folders } of gone.values()) {
    const scopeRoots = roots(scopeFor(root), root);
    await withLease(scopeRoots, { wait: true }, () => forgetOrigins(scopeRoots, registry, folders));
  }
}

/** The folders each job's folder step publishes from, with the scope it keeps them in. */
function watches(jobs: readonly Job[]): Watch[] {
  return jobs.flatMap((job) => {
    const root = job.steps.find((step) => step.root !== undefined)?.root;
    if (root === undefined) return [];
    return job.steps.flatMap((step) =>
      step.kind !== "origins"
        ? []
        : step.select.map((selector) => ({
            root,
            registry: (step.to ?? "").split("/")[0] ?? "",
            folder: expandHome(selector.from),
          })),
    );
  });
}

/**
 * An account resolves through the user-scope manifest, so a project's own alias
 * has to reach it too, at the folder the project's relative location names.
 */
async function declareForAccounts(
  alias: string,
  source: RegistrySource | undefined,
  base: string,
): Promise<void> {
  const user = roots("user", process.cwd());
  const manifest = await readManifest(user.manifest);
  if (manifest.registries[alias] !== undefined || source === undefined) return;
  manifest.registries[alias] = { ...source, location: expandLocation(source.location, base) };
  await writeManifest(user, manifest);
}

/**
 * The account is the job's handle on its registry, so one needing no
 * credential still gets a bare row for the job to name.
 */
async function bindAccount(config: RegistryConfig, alias: string): Promise<Account> {
  const existing = config.accounts.find((account) => account.registry === alias);
  if (existing !== undefined) return existing;
  const service = new AccountService();
  // Resolved before anything is written: a refusal must leave no row behind.
  let resolved: Awaited<ReturnType<AccountService["resolve"]>>;
  try {
    resolved = await service.resolve({ id: "", registry: alias });
  } catch (cause) {
    throw new ProtocolError(RpcErrorCode.InvalidParams, messageOf(cause));
  }
  if (resolved.adapter.auth !== undefined) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `${alias} needs a signed-in account for a job to run as.`,
      {
        code: ErrorCode.Unauthorized,
        hint: `Run \`aireg auth login ${alias}\`. A job never sees ${tokenVariable(alias)}, since the daemon does not inherit it.`,
      },
    );
  }
  return service.adopt(alias);
}

/** An existing entry is never rewritten, only given settings it had none of. */
async function declareRegistry(
  scopeRoots: Roots,
  alias: string,
  location: string | undefined,
  adapter: string | undefined,
  config: SourceConfig,
  refs: readonly Ref[],
): Promise<void> {
  const { scope } = scopeRoots;
  const manifest = await readManifest(scopeRoots.manifest);
  const existing = manifest.registries[alias];
  let changed = false;
  if (existing === undefined) {
    if (location === undefined)
      throw unknownRegistry(alias, scope, Object.keys(manifest.registries));
    manifest.registries[alias] = { location, adapter, config };
    changed = true;
  } else if (Object.keys(existing.config).length === 0 && Object.keys(config).length > 0) {
    existing.config = config;
    changed = true;
  } else if (!sameConfig(existing.config, config) && Object.keys(config).length > 0) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `Registry ${quoted(alias)} is already declared with the settings ` +
        `${JSON.stringify(existing.config)}, not ${JSON.stringify(config)}.`,
    );
  }

  // By address: a second spelling or version of a declared artifact is not a second entry.
  const declared = new Set(manifest.artifacts.map(formatAddress));
  for (const ref of refs) {
    if (declared.has(formatAddress(ref)) || coveredByWhole(ref, manifest.artifacts)) continue;
    declared.add(formatAddress(ref));
    manifest.artifacts.push(ref);
    changed = true;
  }
  if (scope === "user" && manifest.targets.length === 0) {
    manifest.targets = [...DEFAULT_TARGETS];
    changed = true;
  }
  if (changed) await writeManifest(scopeRoots, manifest);
}

function sameConfig(left: SourceConfig, right: SourceConfig): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** The folders asked for, joined to those the job already watches for the same destination. */
function originsStep(
  params: Record<string, unknown>,
  existing: Job | undefined,
  scope: Scope,
): Step | undefined {
  const before = existing?.steps.find((step) => step.kind === "origins");
  if (params.origins === undefined) return before;
  const asked = inputs.object(params.origins, "origins");
  const to = inputs.text(asked, "to");
  const from = inputs.optionalNames(asked, "from") ?? [];
  if (!/^[^/\s]+\/[^/\s]+$/.test(to)) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `The destination must be <registry>/<namespace>, not ${quoted(to)}.`,
    );
  }
  const kept = before?.select.map((selector) => selector.from) ?? [];
  // One job publishes to one place, so moving its folders elsewhere is asked for, never done in passing.
  if (before !== undefined && before.to !== to && kept.length > 0) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `This scope already publishes ${list(kept)} to ${before.to}.`,
      {
        code: ErrorCode.Usage,
        hint: `Publish to ${before.to} instead, or first run \`${unwatchCommand(kept, scope)}\`.`,
      },
    );
  }
  const folders = [...new Set([...kept, ...from])];
  return {
    name: "origins",
    kind: "origins",
    needs: [],
    to,
    select: folders.map((folder) => ({ from: folder })),
    policy: "on",
    extra: {},
  };
}

/** The axes a caller named and the defaults leave out: first publishes, and claiming copies. */
function optionalSteps(policy: SyncPolicy, root: string): Step[] {
  return OPTIONAL_AXES.flatMap((axis) => {
    const level = policy[axis];
    return level === undefined
      ? []
      : [{ name: axis, kind: axis, needs: ["pull"], root, select: [], policy: level, extra: {} }];
  });
}

/** Every plain config edit as one transaction, so it lands on one revision. */
export async function patchSettings(raw: unknown): Promise<{ config: RegistryConfig }> {
  const params = inputs.object(raw);
  const expectedRevision = inputs.integer(params, "expectedRevision");
  const config = await readConfig();

  const edits = params.jobs === undefined ? {} : inputs.object(params.jobs, "jobs");
  const upsert = (inputs.list(edits, "upsert") ?? []).map((entry) => inputs.job(entry));
  const remove = new Set(inputs.optionalNames(edits, "remove") ?? []);
  for (const id of remove) {
    if (!config.jobs.some((job) => job.id === id)) {
      throw new ProtocolError(RpcErrorCode.NotFound, `No job named ${quoted(id)}.`);
    }
  }
  // An id on both sides is a caller contradicting itself, not an ordering to guess at.
  const collision = upsert.find(({ id }) => remove.has(id));
  if (collision !== undefined) {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      `Job ${quoted(collision.id)} cannot be both added and removed in one change.`,
    );
  }

  const replaced = new Set(upsert.map(({ id }) => id));
  const jobs = [...config.jobs.filter(({ id }) => !remove.has(id) && !replaced.has(id)), ...upsert];
  const paused = params.paused === undefined ? config.paused : inputs.flag(params, "paused");
  const saved = await committed(() => writeConfig({ ...config, jobs, paused }, expectedRevision));
  await forgetUnwatched(config.jobs, jobs);
  return { config: saved };
}
