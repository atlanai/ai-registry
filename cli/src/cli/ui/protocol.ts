/**
 * The contract between the `aireg ui` server and its page: JSON-RPC over `POST /rpc`,
 * pushed events over `GET /events` (server-sent events). The page imports these types.
 * Names and shapes follow the daemon's protocol in `daemon/rpc/methods.ts`, so this server
 * can become a bridge to the daemon without the page changing.
 */

export interface UiLink {
  target: string;
  path: string;
  present: boolean;
  ok: boolean;
}

/** One row: something a registry publishes, or something installed here. */
export interface UiArtifact {
  /** `<registry>/<namespace>/<kind>/<name>` for a listed artifact, unique for the rest. */
  key: string;
  name: string;
  namespace: string;
  registry: string;
  kind: string;
  version: string;
  installedVersion: string;
  description: string;
  /** The console's state (`ok`, `edited`, `missing`, ...), or `available`. */
  state: string;
  detail: string;
  digest: string;
  diskDigest: string;
  /** Under `~`. */
  path: string;
  links: UiLink[];
  harnesses: string[];
  listed: boolean;
  /** False for unmanaged local folders and skills a plugin carries. */
  removable: boolean;
  carriedBy: string | undefined;
}

export interface UiRegistry {
  name: string;
  address: string;
  count: number;
  installed: number;
  error: string | undefined;
  loading: boolean;
}

export interface UiJob {
  id: string;
  name: string;
  enabled: boolean;
  intervalSeconds: number | undefined;
  nextRunAtMs: number | undefined;
}

export interface UiRunSummary {
  id: string;
  label: string;
  state: string;
  startedAtMs: number;
  endedAtMs: number | undefined;
  error: string | undefined;
}

export interface UiState {
  artifacts: UiArtifact[];
  registries: UiRegistry[];
  scope: string;
  /** The folder every write runs in, under `~`. */
  root: string;
  daemon: { running: boolean; detail: string };
  jobs: UiJob[];
  runs: UiRunSummary[];
  problems: string[];
  readAtMs: number;
  version: string;
}

export interface UiFile {
  key: string;
  /** Raw markdown; the page renders and sanitizes it. */
  text: string;
  /** Where it was read: the installed copy or the registry. */
  from: "installed" | "registry";
}

export interface UiPlanChange {
  name: string;
  kind: string;
  action: string;
  version: string;
}

export interface UiTrustNeeded {
  plugin: string;
  /** What it carries that runs as you: hooks, servers, programs. */
  carries: string[];
}

/** A dry run the server keeps; only `install.apply` with its id can act on it. */
export interface UiPlan {
  planId: string;
  source: string;
  changes: UiPlanChange[];
  trustNeeded: UiTrustNeeded[];
  /** The CLI's own dry-run output, for detail. */
  output: string;
  /** The exact command `install.apply` will run, for copying. */
  command: string;
}

export interface UiRunStarted {
  runId: string;
  command: string;
}

export interface UiDoctor {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  output: string;
}

interface Method<Params, Result> {
  params: Params;
  result: Result;
}

export interface UiMethods {
  "state.snapshot": Method<Record<string, never>, UiState>;
  "artifact.file": Method<{ key: string }, UiFile>;
  "install.plan": Method<{ source: string; select?: string[] }, UiPlan>;
  /** `trust` must be a subset of the plan's `trustNeeded` plugins. */
  "install.apply": Method<{ planId: string; trust: string[] }, UiRunStarted>;
  "remove.start": Method<{ key: string }, UiRunStarted>;
  "sync.start": Method<Record<string, never>, UiRunStarted>;
  "doctor.run": Method<Record<string, never>, UiDoctor>;
  "run.cancel": Method<{ runId: string }, { cancelled: boolean }>;
}

export type UiMethod = keyof UiMethods;

export interface UiRpcRequest<M extends UiMethod = UiMethod> {
  jsonrpc: "2.0";
  id: number;
  method: M;
  params: UiMethods[M]["params"];
}

export type UiRpcResponse<M extends UiMethod = UiMethod> =
  | { jsonrpc: "2.0"; id: number; result: UiMethods[M]["result"] }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

export type UiRunEventBody =
  | { eventType: "run.output"; data: { line: string } }
  | { eventType: "run.finished"; data: { ok: boolean; exitCode: number | null; summary: string } };

/** The daemon's `RunEvent`, less the per-artifact fields a child's output does not give. */
export type UiRunEvent = { runId: string; seq: number; occurredAtMs: number } & UiRunEventBody;

export interface UiNotifications {
  /** State on disk changed; the page asks for `state.snapshot` again. */
  "state.changed": { readAtMs: number };
  "run.event": UiRunEvent;
}

/** Server-sent events on `GET /events`; the SSE `event:` field is `type`. */
export type UiEvent = {
  [N in keyof UiNotifications]: { type: N } & UiNotifications[N];
}[keyof UiNotifications];
