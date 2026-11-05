import { credentialsForManifest } from "#accounts/credentials.ts";
import type { Artifact } from "#adapter/index.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { adapterFor, declaredLayout } from "#core/adapter/load.ts";
import { readOnlyLayout } from "#core/adapter/read-only.ts";
import type { Account } from "#core/config/model.ts";
import { withLease } from "#core/lease/lease.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { movedPluginLinks } from "#core/plan/projection.ts";
import { RunEventType, type RunMode, type RunPhase } from "#core/run/model.ts";
import { backupStamp } from "#core/store/backups.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load } from "#engine/scope/load.ts";
import { type Claim, moveAside, surveyClaims } from "./claim.ts";
import {
  artifactKey,
  classify,
  type Overrides,
  outcomeOf,
  type Publishable,
  pendingOrigins,
  type Scoped,
  type SyncExecution,
  type SyncExecutionHooks,
  type SyncOutcome,
  summarizeExecution,
} from "./decide.ts";
import { registryOf, syncOptions } from "./inspect.ts";
import { applyLocal } from "./local.ts";
import { type RunScope, scopedKeys } from "./narrow.ts";
import { applyOrigins, type OriginOutcome, originKey, takeIntoOrigins } from "./origins.ts";
import { settlePublished } from "./publish-settle.ts";
import {
  mutateRemote,
  partialMutation,
  type RemoteMutationHooks,
  type RemoteMutationResult,
} from "./remote.ts";
import { closeScan, type Scan, scan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

export interface ExecuteSyncOptions {
  work: ScopeWork;
  account: Account;
  mode: RunMode;
  /** Undefined runs everything the job covers. */
  refs?: RunScope;
  signal: AbortSignal;
  hooks: SyncExecutionHooks;
  overrides?: Overrides | undefined;
}

interface SyncRun {
  work: ScopeWork;
  account: Account;
  mode: RunMode;
  refs: RunScope;
  signal: AbortSignal;
  hooks: SyncExecutionHooks;
  overrides: Overrides;
  common: CommonOptions;
  publishable: Publishable;
  rescan: (loaded: Loaded) => Promise<Scan>;
}

type Claimed = Claim & { keys: string[] };

interface Classification {
  scoped: Scoped;
  outcomes: SyncOutcome[];
  operations: ReadonlyMap<string, SyncOperation>;
  pending: OriginOutcome[];
  /** Publishes and archives, reported once the registry answers. */
  deferred: SyncOutcome[];
  /** Outcomes an import is about to change, reported after the rescan that follows it. */
  held: SyncOutcome[];
  claimed: Claimed[];
  /** Whether the run writes here or upstream, and so needs the lease. */
  writes: boolean;
}

interface Imported {
  current: Scan;
  operations: ReadonlyMap<string, SyncOperation>;
  deferred: SyncOutcome[];
  /** Lock keys the import refreshed. */
  refreshed: readonly string[];
  settled: ReadonlyMap<SyncOutcome, SyncOutcome>;
}

interface LocalWrite {
  scoped: Scoped;
  claimed: readonly Claimed[];
  loaded: Loaded;
  current: Scan;
  writes: ReadonlySet<string>;
  /** Lock keys the import refreshed. */
  refreshed: readonly string[];
  remote: RemoteMutationResult;
}

export async function executeSync(options: ExecuteSyncOptions): Promise<SyncExecution> {
  // Every scan is closed when the run ends, not when the next replaces it: a
  // pull may still be reading from an earlier one's sources.
  const scans: Scan[] = [];
  const scanned = async (...args: Parameters<typeof scan>): Promise<Scan> => {
    const found = await scan(...args);
    scans.push(found);
    return found;
  };
  try {
    return await executeScanned(options, scanned);
  } finally {
    await Promise.all(scans.map(closeScan));
  }
}

async function executeScanned(
  options: ExecuteSyncOptions,
  scanning: typeof scan,
): Promise<SyncExecution> {
  const common = syncOptions(options.work, options.refs);
  const loaded = await load(common, options.work.root);
  const run: SyncRun = {
    work: options.work,
    account: options.account,
    mode: options.mode,
    refs: options.refs,
    signal: options.signal,
    hooks: options.hooks,
    overrides: options.overrides ?? new Map(),
    common,
    publishable: await publishableTo(options.account, registryOf(loaded, options.account)),
    rescan: scannerFor(options, common, scanning),
  };
  const current = await listRun(run, loaded);
  const classification = await classifyRun(run, loaded, current);
  const outcomes = classification.writes
    ? await applyRun(run, loaded, classification)
    : classification.outcomes;
  return finalizeRun(run.hooks, outcomes);
}

/**
 * An adapter that cannot publish a kind reports those candidates and settles, rather than
 * failing the whole run at write time every interval.
 */
async function publishableTo(account: Account, source: RegistrySource): Promise<Publishable> {
  // An adapter that fails to load is reported when the publish opens it.
  const adapter = await adapterFor(
    source.location,
    source.adapter,
    declaredLayout(source.config),
  ).catch(() => undefined);
  // A source read by its layout, such as a folder of skills, takes no publishes whatever its adapter.
  const laidOut = readOnlyLayout(account.registry, source.config) !== undefined;
  return (kind: ArtifactKind) =>
    !laidOut &&
    (adapter === undefined ||
      (adapter.capabilities.publish !== false &&
        (adapter.publishKinds === undefined || adapter.publishKinds.includes(kind))));
}

function scannerFor(
  { account, work, signal, hooks }: ExecuteSyncOptions,
  common: CommonOptions,
  scanning: typeof scan,
): SyncRun["rescan"] {
  const downloaded = new Set<string>();
  const onDownload = (artifact: Artifact) => {
    const name = artifact.envelope.metadata.name;
    if (downloaded.has(name)) return;
    downloaded.add(name);
    hooks.event(RunEventType.Progress, "downloading", name, { step: "downloading" });
  };
  // Only this job's registry: opening another account's lets two organizations on one tree
  // fail each other's runs.
  const aliases = [account.registry];
  return async (loaded) => {
    // Released for the manifest each scan reads, which a reload may change, and checked against
    // every declared alias, since two can read one token variable.
    registryOf(loaded, account);
    const credentials = await credentialsForManifest(
      loaded.manifest.registries,
      work.root,
      signal,
      aliases,
    );
    return scanning(loaded, common, { aliases, credentials, signal, onDownload });
  };
}

async function listRun(run: SyncRun, loaded: Loaded): Promise<Scan> {
  enter(run.hooks, "listing");
  return run.rescan(loaded);
}

async function classifyRun(run: SyncRun, loaded: Loaded, current: Scan): Promise<Classification> {
  const { work, account, hooks } = run;
  enter(hooks, "classifying");
  // Before anything is classified: a ref that reaches nothing is the caller's
  // mistake, not an empty run.
  const scoped = scopedKeys(run.refs, current, account.registry);
  const classified = classifyScan(run, scoped, current);
  const outcomes = [...classified.outcomes.values()];
  // Read before the lease and reported either way: an import that changed is a
  // local write, so it needs the lease even when nothing goes upstream.
  const pending = await pendingOrigins(work, loaded, hooks);
  // What an import is about to change settles as the rescan after it classifies it.
  const importing = new Set(
    pending.filter((item) => item.state === "refreshed").map((item) => originKey(item.origin)),
  );
  // Settled after the publish, so a refusal is reported on its own artifact.
  const { deferred, held } = reportClassified(outcomes, hooks, importing);
  const { claimed, attention } = await claims(run, current, scoped);
  return {
    scoped,
    outcomes: [...outcomes, ...attention],
    operations: new Map([...classified.outcomes].map(([key, item]) => [key, item.operation])),
    pending,
    deferred,
    held,
    claimed,
    writes:
      classified.mutates ||
      classified.writes.size > 0 ||
      pending.length > 0 ||
      claimed.length > 0 ||
      movedPluginLinks(loaded.lock, loaded, new Set([account.registry])).size > 0,
  };
}

function classifyScan(run: SyncRun, scoped: Scoped, current: Scan): ReturnType<typeof classify> {
  return classify(
    current,
    run.work,
    run.account.registry,
    scoped,
    run.mode,
    run.overrides,
    run.publishable,
  );
}

/**
 * Reports each classified outcome now, except a publish or archive, which waits for its answer,
 * and one an import is about to change, which is held for the rescan after it.
 */
function reportClassified(
  outcomes: readonly SyncOutcome[],
  hooks: SyncExecutionHooks,
  importing: ReadonlySet<string>,
): { deferred: SyncOutcome[]; held: SyncOutcome[] } {
  const deferred: SyncOutcome[] = [];
  const held: SyncOutcome[] = [];
  for (const outcome of outcomes) {
    if (sends(outcome)) deferred.push(outcome);
    else if (importing.has(outcome.artifact)) held.push(outcome);
    else reportOutcome(outcome, hooks);
  }
  return { deferred, held };
}

function sends(outcome: SyncOutcome): boolean {
  return (
    (outcome.operation === "publish" || outcome.operation === "archive") &&
    outcome.failure === undefined
  );
}

function reportOutcome(outcome: SyncOutcome, hooks: SyncExecutionHooks): void {
  // An error code alone cannot say which artifact the registry lost.
  hooks.item(
    outcome.artifact,
    "classifying",
    {
      outcome: outcome.failure === undefined ? outcomeOf(outcome.operation) : "failed",
      kind: outcome.kind,
      disposition: outcome.disposition,
      operation: outcome.operation,
      ...(outcome.failure === undefined
        ? {}
        : { errorCode: outcome.failure.code, retryable: outcome.failure.retryable }),
    },
    outcome.detail === undefined ? undefined : { detail: outcome.detail },
  );
}

/**
 * Already-published folders in a target directory, when the job claims them: a differing copy
 * is held for a person, and identical ones are moved aside once the registry's copy is pulled.
 */
async function claims(
  { work, account, mode, hooks }: SyncRun,
  current: Scan,
  scoped: Scoped,
): Promise<{ claimed: Claimed[]; attention: SyncOutcome[] }> {
  // Opt-in: without it a person's folder is theirs, and the registry copy is left out instead.
  if (work.policy.claim !== "on") return { claimed: [], attention: [] };
  if (scoped !== undefined || mode === "publish") return { claimed: [], attention: [] };
  const registry = account.registry;
  const claimed: Claimed[] = [];
  const attention: SyncOutcome[] = [];
  for (const claim of await surveyClaims(current.undeclared, current.acquired, registry)) {
    // Only what this job installs: moving anything else would leave nothing in its place.
    const keys = current.items
      .filter((item) => item.source === registry && claim.entries.includes(item.path))
      .map((item) => item.name);
    if (keys.length === 0) continue;
    if (claim.identical.length > 0 && work.policy.pull === "on") {
      claimed.push({ ...claim, keys });
    }
    if (claim.different.length === 0) continue;
    attention.push({
      artifact: claim.name,
      kind: claim.kind,
      disposition: "conflict",
      operation: "attention",
    });
    hooks.item(
      claim.name,
      "classifying",
      { outcome: "attention", kind: claim.kind, disposition: "conflict", operation: "attention" },
      {
        detail: `changed here and in ${registry}`,
        paths: claim.different.map((copy) => copy.from),
      },
    );
  }
  return { claimed, attention };
}

/** The import, publish and write, under one lease. */
async function applyRun(
  run: SyncRun,
  loaded: Loaded,
  classification: Classification,
): Promise<SyncOutcome[]> {
  const { account, hooks, signal } = run;
  // One lease over the publish and the write, and it waits rather than fails:
  // the expensive half already happened outside it, so the wait is short.
  return withLease(loaded.roots, { wait: true, signal }, async () => {
    // Before the rescan, so the pull links the registry's copy where these sat.
    await moveClaimedAside(classification.claimed, loaded.roots, account.registry, hooks);
    const rebased = await rebase(run, classification.scoped);
    const imported = await importPending(run, classification, rebased);
    // A refused publish must not skip pulls the run already classified.
    const { remote, remoteError } = await publishAndSettle(
      (hooksFor) =>
        mutateRemote(
          imported.current,
          rebased.loaded.roots,
          registryOf(rebased.loaded, account),
          account,
          imported.operations,
          signal,
          hooksFor,
        ),
      imported.deferred,
      hooks,
    );
    await writeLocal(run, {
      scoped: classification.scoped,
      claimed: classification.claimed,
      loaded: rebased.loaded,
      current: imported.current,
      writes: rebased.writes,
      refreshed: imported.refreshed,
      remote,
    });
    if (remoteError !== undefined) throw remoteError;
    return classification.outcomes.map((item) => imported.settled.get(item) ?? item);
  });
}

/** The identical copies a claim found, moved aside so the pull can link the registry's. */
async function moveClaimedAside(
  claimed: readonly Claim[],
  roots: Parameters<typeof moveAside>[3],
  registry: string,
  hooks: SyncExecutionHooks,
): Promise<void> {
  const stamp = backupStamp();
  for (const claim of claimed) {
    const moved = await moveAside(claim.kind, claim.name, claim.identical, roots, stamp);
    if (moved.length === 0) continue;
    const from = moved.map((copy) => copy.from).join(", ");
    const to = moved.map((copy) => copy.to).join(", ");
    hooks.event(RunEventType.Progress, "claiming", claim.name, {
      step: "claimed",
      detail: `already in ${registry}; moved ${from} to ${to}`,
    });
  }
}

// Another lease holder may have written the lock meanwhile, so the plan is rebased on it.
async function rebase(
  run: SyncRun,
  scoped: Scoped,
): Promise<{ loaded: Loaded; current: Scan; writes: ReadonlySet<string> }> {
  const loaded = await load(run.common, run.work.root);
  const current = await run.rescan(loaded);
  return { loaded, current, writes: classifyScan(run, scoped, current).writes };
}

// After the pull, a name the registry publishes is in the lock, so a colliding import is
// reported rather than sent as a rival.
async function importPending(
  run: SyncRun,
  classification: Classification,
  { loaded, current }: { loaded: Loaded; current: Scan },
): Promise<Imported> {
  const { hooks } = run;
  const initial = classification.operations;
  const imported = await applyOrigins(classification.pending, loaded.lock, loaded.roots);
  warnRefused(imported.refused, hooks);
  // The copies moved, so a push has to reread. Not the lock: the rows just
  // written live in it, and rereading would discard them.
  let rescanned = current;
  let operations = initial;
  let deferred = classification.deferred;
  let after: ReturnType<typeof classify> | undefined;
  if (imported.refreshed.length > 0) {
    rescanned = await run.rescan(loaded);
    // What was just imported is classified now, so it goes out in this run rather than the next.
    after = classifyScan(run, classification.scoped, rescanned);
    const refreshed = refreshedKeys(imported.refreshed, loaded.lock);
    operations = withRefreshed(initial, refreshed, after);
    deferred = importedDeferred(deferred, rescanned, refreshed, after.outcomes, initial);
  }
  const held = settleHeld(classification.held, after, imported.refreshed, hooks);
  return {
    current: rescanned,
    operations,
    deferred: [...deferred, ...held.deferred],
    refreshed: imported.refreshed,
    settled: held.settled,
  };
}

function warnRefused(
  refused: readonly { name: string; reason: string }[],
  hooks: SyncExecutionHooks,
): void {
  for (const { name, reason } of refused) {
    hooks.event(RunEventType.Warning, "importing", name, {
      message: `Kept the previous copy of ${name}: ${reason}.`,
    });
  }
}

/** The lock keys an import refreshed, as outcome keys: the row it just wrote says the kind. */
function refreshedKeys(refreshed: readonly string[], lock: Loaded["lock"]): string[] {
  return refreshed.flatMap((name) => {
    const row = lock.artifacts[name];
    return row === undefined ? [] : [artifactKey(row.kind, name)];
  });
}

function withRefreshed(
  operations: ReadonlyMap<string, SyncOperation>,
  /** Outcome keys, from `refreshedKeys`. */
  refreshed: readonly string[],
  after: ReturnType<typeof classify>,
): Map<string, SyncOperation> {
  const updated = new Map(operations);
  for (const key of refreshed) {
    const item = after.outcomes.get(key);
    if (item !== undefined) updated.set(key, item.operation);
  }
  return updated;
}

/**
 * A folder found before the import is a lock row after it, under the row's name: it settles
 * once, as that row, and the outcome classified for the folder is dropped.
 */
function importedDeferred(
  deferred: readonly SyncOutcome[],
  current: Scan,
  /** Outcome keys, from `refreshedKeys`. */
  refreshed: readonly string[],
  after: ReadonlyMap<string, SyncOutcome>,
  initial: ReadonlyMap<string, SyncOperation>,
): SyncOutcome[] {
  const present = new Set([
    ...current.items.map((item) => item.name),
    ...current.local.map((item) => item.name),
  ]);
  const imported = refreshed.flatMap((key) => {
    const item = after.get(key);
    const sends = item?.operation === "publish" || item?.operation === "archive";
    return item !== undefined && sends && item.failure === undefined && !initial.has(key)
      ? [item]
      : [];
  });
  return [...deferred.filter((item) => present.has(item.artifact)), ...imported];
}

/** A held row settles as the rescan after its import classified it, in the counts too. */
function settleHeld(
  held: readonly SyncOutcome[],
  after: { outcomes: ReadonlyMap<string, SyncOutcome> } | undefined,
  refreshed: readonly string[],
  hooks: SyncExecutionHooks,
): { deferred: SyncOutcome[]; settled: Map<SyncOutcome, SyncOutcome> } {
  const deferred: SyncOutcome[] = [];
  const settled = new Map<SyncOutcome, SyncOutcome>();
  for (const before of held) {
    const now =
      (refreshed.includes(before.artifact)
        ? after?.outcomes.get(artifactKey(before.kind, before.artifact))
        : undefined) ?? before;
    settled.set(before, now);
    if (sends(now)) deferred.push(now);
    else reportOutcome(now, hooks);
  }
  return { deferred, settled };
}

/** Publishes, then settles each deferred outcome on what its own artifact met. */
async function publishAndSettle(
  mutate: (hooks: RemoteMutationHooks) => Promise<RemoteMutationResult>,
  deferred: readonly SyncOutcome[],
  hooks: SyncExecutionHooks,
): Promise<{ remote: RemoteMutationResult; remoteError: unknown }> {
  let remote: RemoteMutationResult = { published: new Map(), archived: new Set() };
  let remoteError: unknown;
  const refusals = new Map<string, unknown>();
  const holds = new Map<string, string>();
  // Only what reached the adapter can have been refused; the rest never left this machine.
  const attempted = new Set<string>();
  try {
    remote = await mutate({
      event: (step, artifact) =>
        hooks.event(RunEventType.Progress, "publishing", artifact, { step }),
      sent: (artifact) => attempted.add(artifact),
      failed: (artifact, error) => refusals.set(artifact, error),
      held: (artifact, reason) => holds.set(artifact, reason),
    });
  } catch (error) {
    remoteError = error;
    // An archive can land before the publish after it fails, and that has
    // already changed what the apply step must be rebased on.
    remote = partialMutation(error) ?? remote;
  }
  settlePublished(
    deferred,
    {
      attempted,
      published: new Set(remote.published.keys()),
      archived: remote.archived,
      refusals,
      holds,
    },
    remoteError,
    hooks,
  );
  return { remote, remoteError };
}

async function writeLocal(run: SyncRun, write: LocalWrite): Promise<void> {
  const { common, work, signal, hooks, overrides, account } = run;
  const { remote, refreshed } = write;
  // A remote mutation changes what is on disk, so the apply step follows the fresh scan.
  const mutated = remote.published.size > 0 || remote.archived.size > 0;
  const loaded = mutated
    ? await reloadKeeping(common, work.root, write.loaded, refreshed)
    : write.loaded;
  const current = mutated ? await run.rescan(loaded) : write.current;
  // A folder step's rows are recorded by the same write as everything else,
  // so the plan has to be told they are part of this run.
  const planned = mutated
    ? classifyScan(run, write.scoped, current).writes
    : [...write.writes, ...refreshed];
  const names = new Set([
    ...planned,
    ...remote.published.keys(),
    ...write.claimed.flatMap((claim) => claim.keys),
  ]);
  signal.throwIfAborted();
  enter(hooks, "applying");
  await applyReported(loaded, common, current, names, remote.published, overrides, hooks);
  await takeTheirs(overrides, current, loaded.roots, account.registry, hooks);
}

/** Folder rows live only in memory until the write, so they cross the reload. */
async function reloadKeeping(
  common: Parameters<typeof load>[0],
  root: string,
  loaded: Awaited<ReturnType<typeof load>>,
  keys: readonly string[],
): Promise<Awaited<ReturnType<typeof load>>> {
  const rows = keys.flatMap((key) => {
    const row = loaded.lock.artifacts[key];
    return row === undefined ? [] : [[key, row] as const];
  });
  const fresh = await load(common, root);
  for (const [key, row] of rows) fresh.lock.artifacts[key] = row;
  return fresh;
}

async function applyReported(
  loaded: Loaded,
  common: CommonOptions,
  current: Scan,
  names: ReadonlySet<string>,
  published: ReadonlyMap<string, string | undefined>,
  overrides: Overrides,
  hooks: SyncExecutionHooks,
): Promise<void> {
  // An override is a person overruling the edit that caused the conflict, so
  // the guard against an unasked-for overwrite has nothing left to protect.
  const forced = [...overrides.values()].some((item) => item === "pull" || item === "remove-local");
  const applied = await applyLocal({
    loaded,
    common,
    scan: current,
    names,
    published,
    force: forced,
    onStep: (action) => {
      if (action.kind !== "record") {
        hooks.event(RunEventType.Progress, "applying", action.name, { step: action.kind });
      }
    },
  });
  // What it did to a person's files, said wherever the run is followed.
  for (const notice of applied.notices) {
    hooks.event(RunEventType.Warning, "applying", undefined, notice);
  }
}

/** `--theirs` on a row of yours writes your folder too, which a pull alone never touches. */
async function takeTheirs(
  overrides: Overrides,
  scan: Scan,
  roots: Parameters<typeof takeIntoOrigins>[0],
  registry: string,
  hooks: SyncExecutionHooks,
): Promise<void> {
  const theirs = scan.items
    .filter((item) => overrides.get(artifactKey(item.kind, item.name)) === "pull")
    .map((item) => item.name);
  if (theirs.length === 0) return;
  for (const taken of await takeIntoOrigins(roots, theirs, backupStamp())) {
    const kept = taken.backup === undefined ? "" : `; yours is in ${taken.backup}`;
    hooks.event(RunEventType.Warning, "applying", taken.name, {
      message: taken.written
        ? `Wrote ${registry}'s ${taken.name} into ${taken.folder}${kept}.`
        : `Kept ${taken.folder} as it is, since aireg may not replace it.`,
    });
  }
}

function finalizeRun(hooks: SyncExecutionHooks, outcomes: SyncOutcome[]): SyncExecution {
  enter(hooks, "finalizing");
  return summarizeExecution(outcomes);
}

function enter(hooks: SyncExecutionHooks, phase: RunPhase): void {
  hooks.event(RunEventType.Phase, phase);
}
