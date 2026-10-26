import type { Identity } from "#adapter/index.ts";
import type { SourceConfig } from "#core/adapter/identity.ts";
import type { Account, Job, RegistryConfig } from "#core/config/model.ts";
import type { NAME } from "#core/product.ts";
import type { RunEvent, RunMode, RunRecord, RunState } from "#core/run/model.ts";
import type { Scope } from "#core/store/paths.ts";
import type { SyncPolicy } from "#core/sync/policy.ts";

export const PROTOCOL_VERSION = 1;

/** The most runs, or run events, one request returns. */
export const MAX_PAGE_SIZE = 500;

/** Who a connection says it is; checked for shape, never trusted. */
export interface ClientInfo {
  kind: "cli";
  name: string;
  version: string;
  instanceId: string;
}

export interface DaemonInfo {
  instanceId: string;
  startedAtMs: number;
  serverNowMs: number;
  /** Present while it finishes its runs on the way out; it answers nothing else then. */
  stopping?: true;
}

/** `mine` publishes this project's bytes as a new version; `theirs` takes the registry's. */
export type ConflictResolution = "mine" | "theirs";

interface CreateSyncJob {
  expectedRevision: number;
  root: string;
  scope?: Scope;
  /** The registry's name in the root's manifest. The account is bound through it. */
  registry: string;
  /** Declares the registry at this address when the root does not name it yet. */
  address?: string;
  adapter?: string;
  /** The registry's adapter config, which only its adapter reads. */
  config?: SourceConfig;
  /** Refs to declare in the manifest. Absent takes the whole registry, unless `declaredOnly`. */
  refs?: string[];
  /** Keep current only what the manifest declares; never subscribe to the whole registry. */
  declaredOnly?: boolean;
  /** Folders of your own artifacts to publish to `<registry>/<namespace>`, added to any already watched. */
  origins?: { to: string; from: string[] };
  name?: string;
  intervalSeconds?: number;
  /** Fields left out fall back to the adapter's default policy. */
  policy?: Partial<SyncPolicy>;
  /** Defaults to true; a disabled job is created intact but never scheduled. */
  enabled?: boolean;
}

interface CreateAdapterJob {
  type: string;
  expectedRevision: number;
  account: string;
  name?: string;
  intervalSeconds?: number;
  enabled?: boolean;
  /** Type-owned fields, stored but never named by aireg. */
  [extra: string]: unknown;
}

type CreateJob = CreateSyncJob | CreateAdapterJob;

interface RpcMethod<Params, Result> {
  params: Params;
  result: Result;
}

export interface DaemonMethods {
  initialize: RpcMethod<
    { protocolVersion: typeof PROTOCOL_VERSION; client: ClientInfo; challenge: string },
    {
      protocolVersion: typeof PROTOCOL_VERSION;
      server: { name: typeof NAME; version: string };
      daemon: DaemonInfo;
      /** The challenge signed with this user's daemon key. */
      proof?: string;
    }
  >;
  "state.snapshot": RpcMethod<
    Record<string, never>,
    { config: RegistryConfig; activeRuns: RunRecord[]; daemon: DaemonInfo }
  >;
  /**
   * `created` is false when an existing row kept its id, which is what lets
   * every job that named it keep working across a re-login.
   */
  "account.login": RpcMethod<
    {
      registry: string;
      /**
       * Declares the registry when the manifest does not name it yet:
       * every other route into `manifest.yml` creates a job as a side effect.
       */
      address?: string;
      adapter?: string;
      config?: SourceConfig;
      defaultNamespace?: string;
      /** Handed to the adapter's sign-in and stored; never logged or sent back. */
      token?: string;
    },
    /** `identity` is who the registry says signed in, when it says. */
    { account: Account; created: boolean; identity?: Identity }
  >;
  /** Deletes the sign-in and keeps the row, so jobs keep their reference. */
  "account.logout": RpcMethod<{ accountId: string }, { accountId: string }>;
  /** Deletes the row. Refused while a job references it. */
  "account.remove": RpcMethod<{ accountId: string }, { accountId: string }>;
  /**
   * Every edit with no other side effect, as one revision. Not a whole-document
   * PUT: accounts change only through sign-in.
   */
  "settings.patch": RpcMethod<
    {
      expectedRevision: number;
      paused?: boolean;
      jobs?: { upsert?: Job[]; remove?: string[] };
    },
    { config: RegistryConfig }
  >;
  /** Separate because it also declares the registry in `manifest.yml`. */
  "job.create": RpcMethod<CreateJob, { config: RegistryConfig; job: Job }>;
  /** Settles one artifact that needs a person, as an ordinary run the UI already follows. */
  "conflict.resolve": RpcMethod<
    { jobId: string; name: string; resolution: ConflictResolution },
    { run: RunRecord }
  >;
  /**
   * The job is built from these params and never persisted, so the run carries
   * no job id - which is what `runs.job_id` being nullable is for.
   */
  "sync.start": RpcMethod<
    {
      root: string;
      scope: Scope;
      registry: string;
      policy: SyncPolicy;
      refs?: string[];
      /** The command's `AIREG_TOKEN_<NAME>` for `registry`: this run's alone, never stored or logged. */
      token?: string;
    },
    { run: RunRecord }
  >;
  /**
   * The job is rebuilt from these params exactly as `sync.start` builds it,
   * because an ephemeral job is never stored to look up again.
   */
  "sync.resolve": RpcMethod<
    {
      root: string;
      scope: Scope;
      registry: string;
      policy: SyncPolicy;
      name: string;
      resolution: ConflictResolution;
      /** As for `sync.start`. */
      token?: string;
    },
    { run: RunRecord }
  >;
  "run.start": RpcMethod<
    /** `refs` scopes one run to chosen artifacts without editing the manifest. */
    { jobId: string; mode: RunMode; refs?: string[] },
    { run: RunRecord }
  >;
  "run.retry": RpcMethod<{ runId: string }, { run: RunRecord }>;
  "run.cancel": RpcMethod<{ runId: string }, { run: RunRecord }>;
  "run.list": RpcMethod<
    { jobId?: string; accountId?: string; state?: RunState; limit?: number },
    { runs: RunRecord[] }
  >;
  "run.get": RpcMethod<{ runId: string }, { run: RunRecord }>;
  "run.events": RpcMethod<
    { runId: string; afterEventId?: number; limit?: number },
    { events: RunEvent[]; hasMore: boolean }
  >;
  /** CLI-only. The process exits after the reply so a newer binary can bind. */
  shutdown: RpcMethod<Record<string, never>, { ok: true }>;
}

export interface DaemonNotifications {
  /** Every initialized client receives live events and resumes with `run.events`. */
  "run.event": RunEvent;
}

export type DaemonMethod = keyof DaemonMethods;
export type DaemonNotification = keyof DaemonNotifications;
