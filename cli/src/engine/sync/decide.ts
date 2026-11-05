import type { ArtifactKind } from "#adapter/kinds.ts";
import { SCANNED_KINDS } from "#core/kinds.ts";
import { listedAt } from "#core/plan/acquire/sources.ts";
import {
  EMPTY_RUN_COUNTS,
  type ItemOutcome,
  type ItemSettled,
  type RunCounts,
  RunErrorCode,
  type RunEventType,
  type RunMode,
  type TerminalRunState,
} from "#core/run/model.ts";
import {
  type Disposition,
  PUBLISH_DISPOSITIONS,
  PULL_DISPOSITIONS,
  type SyncItem,
} from "#core/sync/model.ts";
import { operation, type SyncOperation } from "#core/sync/policy.ts";
import type { Loaded } from "#engine/scope/load.ts";
import { shadowedByYours } from "./claim.ts";
import { type OriginOutcome, surveyOrigins } from "./origins.ts";
import type { Scan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

export interface SyncOutcome {
  artifact: string;
  kind: ArtifactKind;
  disposition: Disposition;
  operation: SyncOperation;
  /** Set when the registry would not serve this one artifact. */
  failure?: { code: string; retryable: boolean };
  /** Why it is in this state, or the adapter's words on a refusal. */
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
  event(type: RunEventType, phase: string, artifact?: string, data?: unknown): void;
  /** How one item settled. Reported, never inferred from an event's data. */
  item(artifact: string, phase: string, settled: ItemSettled, data?: unknown): void;
}

const OUTCOMES = {
  none: "unchanged",
  pull: "changed",
  "remove-local": "changed",
  publish: "changed",
  archive: "changed",
  forget: "changed",
  attention: "attention",
  report: "attention",
  ignore: "skipped",
} as const satisfies Record<SyncOperation, ItemOutcome>;

export function outcomeOf(operation: SyncOperation): ItemOutcome {
  return OUTCOMES[operation];
}

// A skill and an agent may share a name, and what is chosen for one must never reach the other.
export function artifactKey(kind: ArtifactKind, name: string): string {
  return `${kind}:${name}`;
}

// Read-only, so it runs before the lease and decides whether one is needed at all.
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

// Every input is already resolved, which is what lets a dry run and a real run agree.
export interface ClassifyInput {
  scan: Scan;
  job: ScopeWork;
  registry: string;
  scoped: Scoped;
  mode: RunMode;
  overrides: Overrides;
  publishable?: Publishable;
}

export function classify(input: ClassifyInput): Classified {
  const { scan, job, registry, scoped, mode, overrides, publishable = () => true } = input;
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
      withLocalRemoval(item, decide(job, overrides, item, item.disposition)),
      publishable(item.kind),
    );
    outcomes.set(artifactKey(item.kind, item.name), decided(item, chosen));
    if (LOCAL_WRITES.includes(chosen)) writes.add(item.name);
    if (item.disposition === "synced" && unrecorded(scan, item)) writes.add(item.name);
    if (chosen === "publish" || chosen === "archive") mutates = true;
  }
  if (mode !== "pull") {
    const adopted = adopt(scan, job, scoped, overrides, publishable);
    for (const item of adopted.outcomes) outcomes.set(artifactKey(item.kind, item.artifact), item);
    if (adopted.mutates) mutates = true;
  }
  return { outcomes, writes, mutates };
}

const LOCAL_WRITES: readonly SyncOperation[] = ["pull", "remove-local", "forget"];

function selected(scoped: Scoped, kind: ArtifactKind, name: string): boolean {
  return scoped === undefined || scoped.has(artifactKey(kind, name));
}

interface Classified {
  /** Keyed by `artifactKey`. */
  outcomes: Map<string, SyncOutcome>;
  /** Settled in the same pass, so what a run reports and what it writes cannot drift apart. */
  writes: Set<string>;
  mutates: boolean;
}

/** `undefined` is everything the job covers; otherwise the keys `scopedKeys` reached. */
export type Scoped = ReadonlySet<string> | undefined;

function relevant(mode: RunMode, disposition: Disposition): boolean {
  if (mode === "sync" || disposition === "conflict" || disposition === "unknown") return true;
  if (disposition === "synced") return true;
  return (mode === "pull" ? PULL_DISPOSITIONS : PUBLISH_DISPOSITIONS).includes(disposition);
}

function withoutPublishing(chosen: SyncOperation, publishable: boolean): SyncOperation {
  if (publishable) return chosen;
  return chosen === "publish" || chosen === "archive" ? "report" : chosen;
}

/** Whether the registry's adapter can publish this kind, known at resolve time, not at write. */
export type Publishable = (kind: ArtifactKind) => boolean;

/** Taking the registry's copy of one it deleted removes this one, and the run must say so. */
function withLocalRemoval(item: SyncItem, chosen: SyncOperation): SyncOperation {
  const deleted =
    item.digests.upstream === undefined &&
    (item.disposition === "conflict" || item.disposition === "pull-delete");
  return chosen === "pull" && deleted ? "remove-local" : chosen;
}

function decide(
  job: ScopeWork,
  overrides: Overrides,
  { kind, name }: { kind: ArtifactKind; name: string },
  disposition: Disposition,
) {
  return overrides.get(artifactKey(kind, name)) ?? operation(disposition, job.policy);
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

// Agreed with the registry, but the lock records nothing or an older serve, as after a publish:
// left alone, `outdated` would report an update whose bytes are already here.
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

/** Local artifacts the registry does not carry yet, and whether one will be published. */
function adopt(
  scan: Scan,
  job: ScopeWork,
  scoped: Scoped,
  overrides: Overrides,
  publishable: Publishable,
): { outcomes: SyncOutcome[]; mutates: boolean } {
  const outcomes: SyncOutcome[] = [];
  let mutates = false;
  const takesNone = !SCANNED_KINDS.some((kind) => publishable(kind));
  for (const candidate of scan.local) {
    if (!selected(scoped, candidate.kind, candidate.name)) continue;
    // A registry that takes no publishes at all, such as a git one, is not waiting
    // on this, so it is skipped rather than reported every run.
    const chosen = takesNone
      ? "ignore"
      : withoutPublishing(decide(job, overrides, candidate, "adopt"), publishable(candidate.kind));
    outcomes.push({
      artifact: candidate.name,
      kind: candidate.kind,
      disposition: "adopt",
      operation: chosen,
    });
    if (chosen === "publish") mutates = true;
  }
  return { outcomes, mutates };
}

export function summarizeExecution(outcomes: SyncOutcome[]): SyncExecution {
  const failed = outcomes.filter(({ failure }) => failure !== undefined).length;
  const settled = outcomes.map(({ operation: item }) => outcomeOf(item));
  const changed = settled.filter((outcome) => outcome === "changed").length;
  const attention = settled.filter((outcome) => outcome === "attention").length;
  const skipped = settled.filter(
    (outcome) => outcome === "unchanged" || outcome === "skipped",
  ).length;
  // A run that got through the rest is not a failure: the artifacts that could
  // not be read are named one by one, and a person decides.
  return {
    state: attention > 0 || failed > 0 ? "attention" : "succeeded",
    counts: { ...EMPTY_RUN_COUNTS, examined: outcomes.length, changed, attention, skipped, failed },
  };
}
