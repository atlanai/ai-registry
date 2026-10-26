/*
 * What the console shows, as values. Nothing here touches a terminal, so the
 * whole read path is testable without one.
 */

import type { ArtifactKind } from "#adapter/index.ts";
import type { State } from "#core/plan/status.ts";
import type { RunCounts, RunMode, RunState, RunTrigger } from "#core/run/model.ts";
import type { Scope } from "#core/store/paths.ts";
import type { SyncPolicy } from "#core/sync/policy.ts";

/** The source of a row for work authored on this machine, which no registry serves yet. */
export const LOCAL_SOURCE = "local";

/** Everything `status` can say, plus what the last sync and this machine's own folders add. */
export type ArtifactState =
  | State
  | "failed"
  | "pending"
  /** Written here, and an adapter job already carries it into the account. */
  | "imported"
  | "unpublished"
  /** A folder of its own with the name of an artifact installed here. */
  | "duplicate";

export interface ArtifactRow {
  /** Lock key. Namespaced (`engineering/lint`) where the registry namespaces. */
  key: string;
  /** What the registry calls it, which a local rename does not change. */
  name: string;
  kind: ArtifactKind;
  /** The registry this came from; `local` for work authored here. */
  registry: string;
  /** The namespace it belongs to. Absent for locally authored work. */
  namespace: string | undefined;
  id: string;
  version: string | undefined;
  /** Digest the lock recorded at install. */
  lockDigest: string;
  /** Digest of this scope's own copy right now. Differs once you edit it. */
  diskDigest: string | undefined;
  state: ArtifactState;
  detail: string | undefined;
  /** Targets this is projected into, by name. */
  targets: string[];
  /** Absolute path of the writable copy a target is served. */
  copy: string;
  /** mtime of that copy, which is when you last changed it. */
  changedAtMs: number | undefined;
  /** The job that imports this local folder, which `p` runs instead of a publish. */
  carriedBy?: string | undefined;
  links: { target: string; path: string; present: boolean; ok: boolean }[];
}

export interface ArtifactGroup {
  /** Namespace, or `LOCAL_GROUP` for work authored on this machine. */
  key: string;
  label: string;
  /** Marked in the tree, because it is where unqualified publishes land. */
  isDefault: boolean;
  authoredHere: boolean;
  rows: ArtifactRow[];
  counts: Record<ArtifactState, number>;
  /** Distinct versions, commonest first, as `0.1.0 x349`. */
  versions: string[];
}

export interface JobRow {
  id: string;
  /** What a person called it, falling back to the id. */
  name: string;
  type: string;
  accountId: string;
  enabled: boolean;
  intervalSeconds: number;
  /** The steps, on one line. */
  summary: string;
  lastRunAtMs: number | undefined;
  nextRunAtMs: number | undefined;
}

export interface RunRow {
  id: string;
  jobId: string | undefined;
  mode: RunMode;
  trigger: RunTrigger;
  state: RunState;
  requestedAtMs: number;
  finishedAtMs: number | undefined;
  counts: RunCounts;
  errorCode: string | undefined;
  /** The run record carries only a code, so the prose comes from the log. */
  reason: string | undefined;
}

export interface AccountRow {
  id: string;
  /** The registry's name, which also names its account on the CLI. */
  registry: string;
  /** The registry's address, as the manifest declares it. */
  address: string;
  /** The registry's adapter config, which only its adapter reads. */
  config: Readonly<Record<string, string>>;
  /** Where the stored token is kept when signed in, which `auth list` does not say. */
  credentialsFile: string | undefined;
  signedIn: boolean;
  /** The registry's adapter has a sign-in at all; a git or folder registry has none. */
  signIn: boolean;
  /** The registry takes published work; aireg never publishes to a git one. */
  publishes: boolean;
  /** Where an unqualified publish lands. */
  defaultNamespace: string | undefined;
  artifactCount: number;
  namespaceCount: number;
}

interface DaemonInfo {
  running: boolean;
  pid: number | undefined;
  jobsEnabled: number;
  jobsTotal: number;
}

export interface LocalSummary {
  skillsImported: number;
  skillsExamined: number;
  failed: number;
  edited: number;
  dangling: number;
  missing: number;
  pending: number;
  imported: number;
  unpublished: number;
  duplicate: number;
}

export interface ConsoleState {
  version: string;
  account: AccountRow | undefined;
  accounts: AccountRow[];
  groups: ArtifactGroup[];
  summary: LocalSummary;
  jobs: JobRow[];
  runs: RunRow[];
  daemon: DaemonInfo;
  policy: SyncPolicy | undefined;
  /** The tree these views describe, which a child command must be told. */
  scope: Scope;
  /** The folder that tree belongs to, where every action runs. */
  root: string;
  /** When this snapshot was taken, so the header can age it. */
  readAtMs: number;
  /** Anything the read could not answer, shown rather than swallowed. */
  problems: string[];
  /** Each contributed panel's own state, by panel id; aireg never reads it. */
  panels: Readonly<Record<string, unknown>>;
}

/** Work authored on this machine has no namespace; it is grouped under this key. */
export const LOCAL_GROUP = "~local";

export const ARTIFACT_STATES: readonly ArtifactState[] = [
  "ok",
  "edited",
  "pending",
  "imported",
  "unpublished",
  "duplicate",
  "failed",
  "dangling",
  "missing",
];

export function emptyCounts(): Record<ArtifactState, number> {
  return {
    ok: 0,
    edited: 0,
    pending: 0,
    imported: 0,
    unpublished: 0,
    duplicate: 0,
    failed: 0,
    dangling: 0,
    missing: 0,
  };
}
