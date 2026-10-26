import { type ArtifactKind, SCANNED_KINDS } from "#core/kinds.ts";
import { listedAt } from "#core/plan/model.ts";
import {
  EMPTY_RUN_COUNTS,
  type ItemOutcome,
  type ItemSettled,
  type RunCounts,
  RunErrorCode,
  type RunMode,
  type TerminalRunState,
} from "#core/run/model.ts";
import {
  type Disposition,
  PUBLISH_DISPOSITIONS,
  PULL_DISPOSITIONS,
  type SyncItem,
} from "#core/sync/model.ts";
import { CHANGING_OPERATIONS, operation, type SyncOperation } from "#core/sync/policy.ts";
import { shadowedByYours } from "./claim.ts";
import { type OriginOutcome, surveyOrigins } from "./origins.ts";
import type { Loaded } from "./pipeline.ts";
import type { Scan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

/**
 * Every input is a value the impure half already resolved, which is what lets a
 * dry run and a real run agree about the plan.
 */
export interface SyncOutcome {
  artifact: string;
  kind: ArtifactKind;
  disposition: Disposition;
  operation: SyncOperation;
  /** Set when the registry would not serve this one artifact. */
  failure?: { code: string; retryable: boolean };
  /** Why it is in this state, or what the adapter said about a refusal, so the run can be read back. */
  detail?: string;
}

/** Keyed by `artifactKey`, and wins over the policy for that one artifact only. */
export type Overrides = ReadonlyMap<string, SyncOperation>;

export interface SyncExecution {
  state: TerminalRunState;
  counts: RunCounts;
  errorCode?: string;
  retryable?: boolean;
}

export interface SyncExecutionHooks {
  event(type: string, phase: string, artifact?: string, data?: unknown): void;
  /** How one item settled. Reported, never inferred from an event's data. */
  item(artifact: string, phase: string, settled: ItemSettled, data?: unknown): void;
}

/** The operation a policy chose, in the vocabulary a count is taken over. */
export function outcomeOf(operation: SyncOperation): ItemOutcome {
  if (CHANGING_OPERATIONS.includes(operation)) return "changed";
  if (operation === "none") return "unchanged";
  if (operation === "ignore") return "skipped";
  return "attention";
}

function relevant(mode: RunMode, disposition: Disposition): boolean {
  if (mode === "sync" || disposition === "conflict" || disposition === "unknown") return true;
  if (disposition === "synced") return true;
  return (mode === "pull" ? PULL_DISPOSITIONS : PUBLISH_DISPOSITIONS).includes(disposition);
}

function decide(
  job: ScopeWork,
  overrides: Overrides,
  { kind, name }: { kind: ArtifactKind; name: string },
  disposition: Disposition,
) {
  return overrides.get(artifactKey(kind, name)) ?? operation(disposition, job.policy);
}

/** Taking the registry's copy of one it deleted removes this one, and the run must say so. */
function taken(item: SyncItem, chosen: SyncOperation): SyncOperation {
  const deleted =
    item.digests.upstream === undefined &&
    (item.disposition === "conflict" || item.disposition === "pull-delete");
  return chosen === "pull" && deleted ? "remove-local" : chosen;
}

const LOCAL_WRITES: readonly SyncOperation[] = ["pull", "remove-local", "forget"];

/**
 * What outcomes and the operations taken from them are keyed by: a skill and an
 * agent may share a name, and what is chosen for one must never reach the other.
 */
export function artifactKey(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
}

interface Classified {
  /** Keyed by `artifactKey`. */
  outcomes: Map<string, SyncOutcome>;
  /** Settled in the same pass, so what a run reports and what it writes cannot drift apart. */
  writes: Set<string>;
  /** Same pass again: whether this round will touch the registry at all. */
  mutates: boolean;
}

/** `undefined` is everything the job covers; otherwise the keys `scopedKeys` reached. */
export type Scoped = ReadonlySet<string> | undefined;

function selected(scoped: Scoped, kind: ArtifactKind, name: string): boolean {
  return scoped === undefined || scoped.has(artifactKey(kind, name));
}

/** Local artifacts the registry does not carry yet. Returns whether one will be published. */
function adopt(
  scan: Scan,
  job: ScopeWork,
  scoped: Scoped,
  overrides: Overrides,
  outcomes: Map<string, SyncOutcome>,
  publishable: Publishable,
): boolean {
  let mutates = false;
  const takesNone = !SCANNED_KINDS.some((kind) => publishable(kind));
  for (const candidate of scan.local) {
    if (!selected(scoped, candidate.kind, candidate.name)) continue;
    // A registry that takes no publishes at all, such as a git one, is not waiting
    // on this, so it is skipped rather than reported every run.
    const chosen = takesNone
      ? "ignore"
      : withoutPublishing(decide(job, overrides, candidate, "adopt"), publishable(candidate.kind));
    outcomes.set(artifactKey(candidate.kind, candidate.name), {
      artifact: candidate.name,
      kind: candidate.kind,
      disposition: "adopt",
      operation: chosen,
    });
    if (chosen === "publish") mutates = true;
  }
  return mutates;
}

/** Whether the registry's adapter can publish this kind, known at resolve time, not at write. */
export type Publishable = (kind: ArtifactKind) => boolean;

function withoutPublishing(chosen: SyncOperation, publishable: boolean): SyncOperation {
  if (publishable) return chosen;
  return chosen === "publish" || chosen === "archive" ? "report" : chosen;
}

/**
 * Read-only, so this runs before the lease and decides whether one is needed at
 * all: a run with nothing to publish still refreshes the copies an edit moved.
 */
export async function pendingOrigins(
  job: ScopeWork,
  loaded: Loaded,
  hooks: SyncExecutionHooks,
): Promise<OriginOutcome[]> {
  const steps = job.steps.filter((step) => step.kind === "origins");
  if (steps.length === 0) return [];
  const outcomes = await surveyOrigins(steps, loaded.lock, loaded.roots);
  const changed = outcomes.filter((item) => item.state !== "unchanged");
  for (const item of changed) {
    const failed = item.state === "missing" || item.state === "refused";
    hooks.item(
      item.origin.name,
      item.origin.step,
      {
        outcome: failed ? "failed" : "changed",
        kind: item.origin.kind,
        ...(item.state === "refused"
          ? { errorCode: RunErrorCode.SyncFailed, retryable: false }
          : {}),
      },
      { origin: item.origin.from, ...(item.reason === undefined ? {} : { detail: item.reason }) },
    );
  }
  // A reporting step surveys and says so; only an applying one copies.
  return steps.every((step) => step.policy === "on") ? changed : [];
}

/**
 * Agreed with the registry, but the lock records nothing or an older serve, as after a publish.
 * Left alone, `outdated` reports an update whose bytes are already here.
 */
function unrecorded(scan: Scan, item: SyncItem): boolean {
  const entry = scan.pinned.artifacts[item.name];
  if (entry === undefined) return true;
  const source = scan.acquired.find((acquired) => acquired.alias === item.source);
  // A row of yours carries its copy's path, not an address, until a publish of it is recorded.
  const at =
    entry.origin === undefined ? item.path : listedAt(entry, source?.catalog.entries ?? []);
  const served = at === undefined ? undefined : source?.placements.get(at)?.contentId;
  return served !== undefined && entry.content !== served;
}

function decided(item: SyncItem, operation: SyncOperation): SyncOutcome {
  const { failure, detail } = item;
  return {
    artifact: item.name,
    kind: item.kind,
    disposition: item.disposition,
    operation,
    ...(failure === undefined ? {} : { failure }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function classify(
  scan: Scan,
  job: ScopeWork,
  registry: string,
  scoped: Scoped,
  mode: RunMode,
  overrides: Overrides,
  publishable: Publishable = () => true,
): Classified {
  const outcomes = new Map<string, SyncOutcome>();
  const writes = new Set<string>();
  let mutates = false;
  // Unless the job claims copies, a folder of yours wins over a registry's of the same name.
  const shadowed = job.policy.claim === "on" ? new Set<string>() : shadowedByYours(scan);
  for (const item of scan.items) {
    if (item.source !== registry || !selected(scoped, item.kind, item.name)) continue;
    if (shadowed.has(item.name)) {
      outcomes.set(artifactKey(item.kind, item.name), {
        artifact: item.name,
        kind: item.kind,
        disposition: item.disposition,
        operation: "ignore",
        detail: "a folder of yours with this name is in use",
      });
      continue;
    }
    // One lock row per name: organizations serving the same name share it, and a job acting
    // on another's row would archive or overwrite that organization's copy.
    const owner = scan.pinned?.artifacts[item.name]?.registry;
    if (owner !== undefined && owner !== registry) continue;
    if (!relevant(mode, item.disposition)) continue;
    const chosen = withoutPublishing(
      taken(item, decide(job, overrides, item, item.disposition)),
      publishable(item.kind),
    );
    outcomes.set(artifactKey(item.kind, item.name), decided(item, chosen));
    if (LOCAL_WRITES.includes(chosen)) writes.add(item.name);
    if (item.disposition === "synced" && unrecorded(scan, item)) writes.add(item.name);
    if (chosen === "publish" || chosen === "archive") mutates = true;
  }
  if (mode !== "pull" && adopt(scan, job, scoped, overrides, outcomes, publishable)) {
    mutates = true;
  }
  return { outcomes, writes, mutates };
}

export function execution(outcomes: SyncOutcome[]): SyncExecution {
  const failed = outcomes.filter(({ failure }) => failure !== undefined).length;
  const changed = outcomes.filter(({ operation: item }) =>
    CHANGING_OPERATIONS.includes(item),
  ).length;
  const attention = outcomes.filter(
    ({ operation: item }) => item === "attention" || item === "report",
  ).length;
  const skipped = outcomes.filter(
    ({ operation: item }) => item === "none" || item === "ignore",
  ).length;
  // A run that got through the rest is not a failure: the artifacts that could
  // not be read are named one by one, and a person decides.
  return {
    state: attention > 0 || failed > 0 ? "attention" : "succeeded",
    counts: { ...EMPTY_RUN_COUNTS, examined: outcomes.length, changed, attention, skipped, failed },
  };
}
