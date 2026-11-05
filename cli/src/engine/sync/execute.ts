import { credentialsForManifest } from "#accounts/credentials.ts";
import type { Artifact } from "#adapter/index.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { adapterFor, declaredLayout } from "#core/adapter/load.ts";
import { readOnlyLayout } from "#core/adapter/read-only.ts";
import type { Account } from "#core/config/model.ts";
import { withLease } from "#core/lease/lease.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { movedPluginLinks } from "#core/plan/projection.ts";
import { type RunMode, WARNING_EVENT } from "#core/run/model.ts";
import { backupStamp } from "#core/store/backups.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load } from "#engine/scope/load.ts";
import { type Claim, moveAside, surveyClaims } from "./claim.ts";
import {
  artifactKey,
  classify,
  execution,
  type Overrides,
  outcomeOf,
  type Publishable,
  pendingOrigins,
  type Scoped,
  type SyncExecution,
  type SyncExecutionHooks,
  type SyncOutcome,
} from "./decide.ts";
import { registryOf, syncOptions } from "./inspect.ts";
import { applyLocal } from "./local.ts";
import { type RunScope, scopedKeys } from "./narrow.ts";
import { applyOrigins, originKey, takeIntoOrigins } from "./origins.ts";
import { settlePublished } from "./publish-settle.ts";
import {
  mutateRemote,
  partialMutation,
  type RemoteMutationHooks,
  type RemoteMutationResult,
} from "./remote.ts";
import { closeScan, type Scan, scan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

export async function executeSync(
  job: ScopeWork,
  account: Account,
  mode: RunMode,
  /** Everything the job covers, unless this run was asked for a narrower set. */
  refs: RunScope,
  signal: AbortSignal,
  hooks: SyncExecutionHooks,
  /** Settles one named artifact whatever the policy would have chosen for it. */
  overrides: Overrides = new Map(),
): Promise<SyncExecution> {
  // Every scan is closed when the run ends, not when the next replaces it: a
  // pull may still be reading from an earlier one's sources.
  const scans: Scan[] = [];
  const scanned = async (...args: Parameters<typeof scan>): Promise<Scan> => {
    const found = await scan(...args);
    scans.push(found);
    return found;
  };
  try {
    return await executeScanned(job, account, mode, refs, signal, hooks, overrides, scanned);
  } finally {
    await Promise.all(scans.map(closeScan));
  }
}

async function executeScanned(
  job: ScopeWork,
  account: Account,
  mode: RunMode,
  refs: RunScope,
  signal: AbortSignal,
  hooks: SyncExecutionHooks,
  overrides: Overrides,
  scanning: typeof scan,
): Promise<SyncExecution> {
  const common = syncOptions(job, refs);
  let loaded = await load(common, job.root);
  const source = registryOf(loaded, account);

  const publishable = await publishableTo(account, source);

  hooks.event("run.phase", "listing");
  const downloaded = new Set<string>();
  const onDownload = (artifact: Artifact) => {
    const name = artifact.envelope.metadata.name;
    if (downloaded.has(name)) return;
    downloaded.add(name);
    hooks.event("artifact.progress", "downloading", name, { step: "downloading" });
  };
  // Only this job's registry: opening another account's lets two organizations on one tree
  // fail each other's runs.
  const aliases = [account.registry];
  // Released for the manifest each scan reads, which a reload may change, and checked against
  // every declared alias, since two can read one token variable.
  const released = () => {
    registryOf(loaded, account);
    return credentialsForManifest(loaded.manifest.registries, job.root, signal, [account.registry]);
  };
  const rescan = async () =>
    scanning(loaded, common, { aliases, credentials: await released(), signal, onDownload });
  let current = await rescan();
  hooks.event("run.phase", "classifying");
  // Before anything is classified: a ref that reaches nothing is the caller's
  // mistake, not an empty run.
  const scoped = scopedKeys(refs, current, account.registry);
  const reclassify = () =>
    classify(current, job, account.registry, scoped, mode, overrides, publishable);
  const classified = reclassify();
  const outcomes = [...classified.outcomes.values()];
  const initialOperations = new Map(
    [...classified.outcomes].map(([key, item]) => [key, item.operation]),
  );
  // Read before the lease and reported either way: an import that changed is a
  // local write, so it needs the lease even when nothing goes upstream.
  const pending = await pendingOrigins(job, loaded, hooks);
  // What an import is about to change settles as the rescan after it classifies it.
  const importing = new Set(
    pending.filter((item) => item.state === "refreshed").map((item) => originKey(item.origin)),
  );
  // Settled after the publish, so a refusal is reported on its own artifact.
  const reported = reportClassified(outcomes, hooks, importing);
  let deferred = reported.deferred;
  const claimed = await claims(current, job, account.registry, scoped, mode, outcomes, hooks);

  if (
    classified.mutates ||
    classified.writes.size > 0 ||
    pending.length > 0 ||
    claimed.length > 0 ||
    movedPluginLinks(loaded.lock, loaded, new Set(aliases)).size > 0
  ) {
    // One lease over the publish and the write, and it waits rather than fails:
    // the expensive half already happened outside it, so the wait is short.
    await withLease(loaded.roots, { wait: true, signal }, async () => {
      // Before the rescan, so the pull links the registry's copy where these sat.
      await moveClaimedAside(claimed, loaded.roots, account.registry, hooks);
      // Whoever held the lease may have written the lock while this run was
      // computing against it, so the plan is rebased on what is there now.
      loaded = await load(common, job.root);
      current = await rescan();
      const rebased = reclassify();

      // After the pull: a name the registry already publishes is claimed by
      // the lock by now, so a colliding import is reported, not sent as a rival.
      const imported = await applyOrigins(pending, loaded.lock, loaded.roots);
      warnRefused(imported.refused, hooks);
      // The copies moved, so a push has to reread. Not the lock: the rows just
      // written live in it, and rereading would discard them.
      let operations: ReadonlyMap<string, SyncOperation> = initialOperations;
      let after: ReturnType<typeof reclassify> | undefined;
      if (imported.refreshed.length > 0) {
        current = await rescan();
        // What was just imported is classified now, so it goes out in this run rather than the next.
        after = reclassify();
        const refreshed = refreshedKeys(imported.refreshed, loaded.lock);
        operations = withRefreshed(initialOperations, refreshed, after);
        deferred = importedDeferred(
          deferred,
          current,
          refreshed,
          after.outcomes,
          initialOperations,
        );
      }
      deferred.push(...settleHeld(reported.held, after, imported.refreshed, outcomes, hooks));

      // A refused publish must not skip pulls the run already classified.
      const { remote, remoteError } = await publishAndSettle(
        (hooksFor) =>
          mutateRemote(
            current,
            loaded.roots,
            registryOf(loaded, account),
            account,
            operations,
            signal,
            hooksFor,
          ),
        deferred,
        hooks,
      );

      let names = rebased.writes;
      // A folder step's rows are recorded by the same write as everything else,
      // so the plan has to be told they are part of this run.
      for (const key of imported.refreshed) names.add(key);
      // A remote mutation changes what is on disk, so the apply step follows the fresh scan.
      if (remote.published.size > 0 || remote.archived.size > 0) {
        loaded = await reloadKeeping(common, job.root, loaded, imported.refreshed);
        current = await rescan();
        names = reclassify().writes;
      }
      for (const name of remote.published.keys()) names.add(name);
      for (const claim of claimed) for (const key of claim.keys) names.add(key);
      signal.throwIfAborted();
      hooks.event("run.phase", "applying");
      await applyReported(loaded, common, current, names, remote.published, overrides, hooks);
      await takeTheirs(overrides, current, loaded.roots, account.registry, hooks);
      if (remoteError !== undefined) throw remoteError;
    });
  }
  hooks.event("run.phase", "finalizing");
  return execution(outcomes);
}

/**
 * An adapter that cannot publish a kind reports those candidates and settles, rather than
 * failing the whole run at write time every interval.
 */
async function publishableTo(account: Account, source: RegistrySource): Promise<Publishable> {
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
  current: Scan,
  job: ScopeWork,
  registry: string,
  scoped: Scoped,
  mode: RunMode,
  outcomes: SyncOutcome[],
  hooks: SyncExecutionHooks,
): Promise<(Claim & { keys: string[] })[]> {
  // Opt-in: without it a person's folder is theirs, and the registry copy is left out instead.
  if (job.policy.claim !== "on") return [];
  if (scoped !== undefined || mode === "publish") return [];
  const moving: (Claim & { keys: string[] })[] = [];
  for (const claim of await surveyClaims(current.undeclared, current.acquired, registry)) {
    // Only what this job installs: moving anything else would leave nothing in its place.
    const keys = current.items
      .filter((item) => item.source === registry && claim.entries.includes(item.path))
      .map((item) => item.name);
    if (keys.length === 0) continue;
    if (claim.identical.length > 0 && job.policy.pull === "on") {
      moving.push({ ...claim, keys });
    }
    if (claim.different.length === 0) continue;
    const outcome: SyncOutcome = {
      artifact: claim.name,
      kind: claim.kind,
      disposition: "conflict",
      operation: "attention",
    };
    outcomes.push(outcome);
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
  return moving;
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
    hooks.event("artifact.progress", "claiming", claim.name, {
      step: "claimed",
      detail: `already in ${registry}; moved ${from} to ${to}`,
    });
  }
}

function warnRefused(
  refused: readonly { name: string; reason: string }[],
  hooks: SyncExecutionHooks,
): void {
  for (const { name, reason } of refused) {
    hooks.event(WARNING_EVENT, "importing", name, {
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
  outcomes: SyncOutcome[],
  hooks: SyncExecutionHooks,
): SyncOutcome[] {
  const deferred: SyncOutcome[] = [];
  for (const before of held) {
    const now =
      (refreshed.includes(before.artifact)
        ? after?.outcomes.get(artifactKey(before.kind, before.artifact))
        : undefined) ?? before;
    outcomes[outcomes.indexOf(before)] = now;
    if (sends(now)) deferred.push(now);
    else reportOutcome(now, hooks);
  }
  return deferred;
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
      event: (step, artifact) => hooks.event("artifact.progress", "publishing", artifact, { step }),
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
  const applied = await applyLocal(loaded, common, current, names, published, forced, (action) => {
    if (action.kind !== "record") {
      hooks.event("artifact.progress", "applying", action.name, { step: action.kind });
    }
  });
  // What it did to a person's files, said wherever the run is followed.
  for (const notice of applied.notices) {
    hooks.event(WARNING_EVENT, "applying", undefined, notice);
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
    hooks.event(WARNING_EVENT, "applying", taken.name, {
      message: taken.written
        ? `Wrote ${registry}'s ${taken.name} into ${taken.folder}${kept}.`
        : `Kept ${taken.folder} as it is, since aireg may not replace it.`,
    });
  }
}
