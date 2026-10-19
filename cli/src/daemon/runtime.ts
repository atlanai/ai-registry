import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { AccountService } from "#accounts/service.ts";
import { list, quoted } from "#adapter/text.ts";
import { updateAdapters } from "#core/adapter/installed/update.ts";
import type { Account } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { tokenVariable, withRegistryTokens } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Fields } from "#core/fields.ts";
import { type Logger, nullLogger } from "#core/log/index.ts";
import { installCrashHandlers, openDaemonLog } from "#core/log/open.ts";
import { NAME } from "#core/product.ts";
import {
  ACTIVE_RUN_STATES,
  isRunMode,
  isTerminal,
  RUN_MODES,
  RUN_STATES,
  type RunEvent,
  type RunRecord,
} from "#core/run/model.ts";
import { type Scope, toolHome, userScopeDir } from "#core/store/paths.ts";
import { RESTART_EXIT_CODE, refreshAutostart, supervised } from "#daemon/autostart/index.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { privateDirectory, rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import {
  type DaemonInfo,
  MAX_PAGE_SIZE,
  PROTOCOL_VERSION,
  ProtocolError,
} from "#daemon/rpc/protocol.ts";
import { DaemonAlreadyRunningError, type RpcContext, RpcServer } from "#daemon/rpc/server.ts";
import { jobOfWork, type ScopeWork } from "#engine/work.ts";
import { loginAccount, logoutAccount, removeAccount } from "./account-methods.ts";
import { applyDaemonAdapterUpdate } from "./adapter-update.ts";
import { resolveConflict, startResolution } from "./conflict-methods.ts";
import * as inputs from "./inputs.ts";
import { createJob, patchSettings } from "./job-methods.ts";
import {
  applyDaemonCliUpdate,
  applyDaemonFollowInstalled,
  DaemonMinUpdate,
  FOLLOW_INTERVAL_MS,
} from "./min-update.ts";
import { liveDaemonPid, releaseDaemonPid, writeDaemonPid } from "./pidfile.ts";
import { runDatabasePath, SqliteRunStore } from "./run-store.ts";
import { SyncRunner } from "./runner.ts";
import { JobScheduler } from "./scheduler.ts";
import { startDaemon } from "./service.ts";

const EVENT_PAGE_SIZE = 200;

/** How often the daemon checks that its home still exists. */
const HOME_WATCH_MS = 15_000;

function noRun(runId: string): ProtocolError {
  return new ProtocolError(RpcErrorCode.NotFound, `No run named ${quoted(runId)}.`);
}

function where(scope: Scope): string {
  return scope === "user" ? "your user scope" : "this project";
}

export class DaemonRuntime {
  readonly #server: RpcServer;
  readonly #runs: SqliteRunStore;
  readonly #version: string;
  readonly #accounts = new AccountService();
  readonly #runner: SyncRunner;
  readonly #scheduler: JobScheduler;
  readonly #minUpdate = new DaemonMinUpdate(() => this.#applyMinUpdate());
  #homeWatch: ReturnType<typeof setInterval> | undefined;
  readonly #follow = new DaemonMinUpdate(
    () => applyDaemonFollowInstalled(this.#replaceHooks()),
    FOLLOW_INTERVAL_MS,
  );
  readonly #instanceId = `daemon_${randomUUID()}`;
  readonly #startedAtMs = Date.now();
  readonly #stopped = new Set<() => void>();
  #closing: Promise<void> | undefined;
  #exitCode = 0;
  readonly #log: Logger;

  private constructor(runs: SqliteRunStore, version: string, log: Logger) {
    this.#runs = runs;
    this.#version = version;
    this.#log = log;
    this.#server = new RpcServer(log);
    this.#runner = new SyncRunner(runs, (event) => this.#emit(event), version, log);
    this.#scheduler = new JobScheduler(runs, this.#runner, log);
    this.#register();
  }

  static async open(version: string, log: Logger = nullLogger()): Promise<DaemonRuntime> {
    // Reclaiming here would let a daemon that loses the bind race mark the
    // winner's live runs abandoned; listen() does it instead.
    const store = await SqliteRunStore.open(runDatabasePath(), (to) =>
      log.warn("run history could not be read, so it was moved aside and started again", { to }),
    );
    return new DaemonRuntime(store, version, log);
  }

  #register(): void {
    this.#server.method("initialize", async () => ({
      protocolVersion: PROTOCOL_VERSION,
      server: { name: NAME, version: this.#version },
      daemon: this.#daemonInfo(),
    }));
    this.#server.method("state.snapshot", async () => {
      const activeRuns = ACTIVE_RUN_STATES.flatMap((state) =>
        this.#runs.list({ state, limit: MAX_PAGE_SIZE }),
      )
        .sort((left, right) => right.requestedAtMs - left.requestedAtMs)
        .slice(0, MAX_PAGE_SIZE);
      return {
        config: await readConfig(),
        activeRuns,
        daemon: this.#daemonInfo(),
      };
    });
    this.#server.method("settings.patch", async (raw) => patchSettings(raw));
    this.#server.method("job.create", async (raw, context) => createJob(raw, context.signal));
    this.#server.method("conflict.resolve", (raw, context) =>
      resolveConflict(raw, context, this.#runner),
    );
    this.#server.method("account.login", async (raw, context) => {
      // Never the credential, only that one was written: enough to answer "am I signed in".
      const result = await loginAccount(raw, context, this.#accounts);
      this.#log.info("account authenticated", { accountId: result.account.id });
      return result;
    });
    this.#server.method("account.logout", async (raw, context) => {
      const result = await logoutAccount(raw, context, this.#accounts);
      this.#log.info("account signed out");
      return result;
    });
    this.#server.method("account.remove", async (raw, context) => {
      const result = await removeAccount(raw, context, this.#accounts);
      this.#log.info("account removed");
      return result;
    });
    this.#server.method("sync.start", async (raw) => this.#syncStart(raw));
    this.#server.method("sync.resolve", async (raw, context) => this.#syncResolve(raw, context));
    this.#server.method("run.start", async (raw) => this.#start(raw));
    this.#server.method("run.retry", async (raw) => this.#retry(raw));
    this.#server.method("run.list", async (raw) => this.#listRuns(raw));
    this.#server.method("run.get", async (raw) => this.#getRun(raw));
    this.#server.method("run.events", async (raw) => this.#events(raw));
    this.#server.method("run.cancel", async (raw) => this.#cancel(raw));
    this.#server.method("shutdown", async () => {
      setImmediate(() => {
        void this.close();
      });
      return { ok: true as const };
    });
  }

  async #listRuns(raw: unknown): Promise<{ runs: RunRecord[] }> {
    const params = inputs.object(raw);
    const limit = params.limit === undefined ? undefined : inputs.integer(params, "limit");
    const jobId = inputs.optionalText(params, "jobId");
    const accountId = inputs.optionalText(params, "accountId");
    const state =
      params.state === undefined ? undefined : inputs.oneOf(params, "state", RUN_STATES);
    if (limit !== undefined && (limit < 1 || limit > MAX_PAGE_SIZE)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        `The limit must be between 1 and ${MAX_PAGE_SIZE}.`,
      );
    }
    return {
      runs: this.#runs.list({
        ...(jobId === undefined ? {} : { jobId }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(state === undefined ? {} : { state }),
        ...(limit === undefined ? {} : { limit }),
      }),
    };
  }

  async #getRun(raw: unknown): Promise<{ run: RunRecord }> {
    const runId = inputs.text(inputs.object(raw), "runId");
    const run = this.#runs.get(runId);
    if (run === undefined) throw noRun(runId);
    return { run };
  }

  /**
   * Never written to config, so the run it drives records no job id - which is
   * what `runs.job_id` being nullable is for.
   */
  async #foregroundTarget(
    params: Record<string, unknown>,
  ): Promise<{ job: ScopeWork; account: Account }> {
    const registry = inputs.text(params, "registry");
    const config = await readConfig();
    // A public repository or a local directory needs no sign-in, so an account
    // is synthesized to name the registry rather than to carry a credential.
    const account = config.accounts.find((entry) => entry.registry === registry) ?? {
      id: `acc_anonymous_${registry}`,
      registry,
    };
    // The runner rebuilds the scope from the step root alone, so a user-scope
    // run must be rooted at the user scope or every registry looks undeclared.
    const scope = inputs.scope(params, "scope", "project");
    const job: ScopeWork = {
      id: `job_foreground_${randomUUID()}`,
      root: scope === "user" ? userScopeDir() : inputs.absolutePath(params, "root"),
      scope,
      account: account.id,
      policy: inputs.syncPolicy(params, "policy"),
      steps: [],
    };
    return { job, account };
  }

  /**
   * A sync of a scope no job covers, which is what a person running `aireg sync`
   * in a project is asking for.
   */
  async #syncStart(raw: unknown): Promise<{ run: RunRecord }> {
    const params = inputs.object(raw);
    const refs = inputs.optionalNames(params, "refs");
    const { job, account } = await this.#foregroundTarget(params);
    return withSuppliedToken(params, async () => ({
      run: await this.#runner.start(job.id, "sync", "manual", {
        ...(refs === undefined ? {} : { refs }),
        ephemeral: { job: jobOfWork(job), account },
      }),
    }));
  }

  /** The same ephemeral job as `sync.start`, over one artifact, with its operation forced. */
  async #syncResolve(raw: unknown, context: RpcContext): Promise<{ run: RunRecord }> {
    const params = inputs.object(raw);
    const { job, account } = await this.#foregroundTarget(params);
    return withSuppliedToken(params, () =>
      startResolution(this.#runner, params, job, account, {
        signal: context.signal,
        place: `from ${account.registry} in ${where(job.scope)}`,
        ephemeral: true,
      }),
    );
  }

  async #start(raw: unknown): Promise<{ run: RunRecord }> {
    const params = inputs.object(raw);
    const jobId = inputs.text(params, "jobId");
    const mode = inputs.text(params, "mode");
    const config = await readConfig();
    const job = config.jobs.find(({ id }) => id === jobId);
    if (job === undefined) {
      throw new ProtocolError(RpcErrorCode.NotFound, `No job named ${quoted(jobId)}.`);
    }
    if (!isRunMode(mode)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        `Unknown run mode ${quoted(mode)}. Use ${list(RUN_MODES, "or")}.`,
      );
    }
    const refs = inputs.optionalNames(params, "refs");
    return {
      run: await this.#runner.start(jobId, mode, "manual", refs === undefined ? {} : { refs }),
    };
  }

  async #events(raw: unknown): Promise<{ events: RunEvent[]; hasMore: boolean }> {
    const params = inputs.object(raw);
    const runId = inputs.text(params, "runId");
    const run = this.#runs.get(runId);
    if (run === undefined) throw noRun(runId);
    const after = params.afterEventId === undefined ? 0 : inputs.integer(params, "afterEventId");
    if (after < 0)
      throw new ProtocolError(RpcErrorCode.InvalidParams, "afterEventId must not be negative.");
    const limit = params.limit === undefined ? EVENT_PAGE_SIZE : inputs.integer(params, "limit");
    if (limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        `The limit must be between 1 and ${MAX_PAGE_SIZE}.`,
      );
    }
    const page = this.#runs.events(runId, after, limit + 1);
    return { events: page.slice(0, limit), hasMore: page.length > limit };
  }

  async #retry(raw: unknown): Promise<{ run: RunRecord }> {
    const params = inputs.object(raw);
    const runId = inputs.text(params, "runId");
    const original = this.#runs.get(runId);
    if (original === undefined) throw noRun(runId);
    if (!isTerminal(original.state)) {
      throw new AiregError(`Run ${quoted(runId)} has not finished, so it cannot be retried yet.`, {
        code: ErrorCode.Conflict,
        hint: `Follow it with \`aireg job runs ${runId} --follow\`.`,
      });
    }
    if (original.jobId === undefined) {
      throw new AiregError(
        `Run ${quoted(runId)} belongs to no job, so there is nothing to run again.`,
        { code: ErrorCode.Conflict, hint: "Run the command that started it again." },
      );
    }
    if (original.state === "succeeded") {
      throw new AiregError(`Run ${quoted(runId)} succeeded, so there is nothing to retry.`, {
        code: ErrorCode.Conflict,
        hint: `Run \`aireg job start ${original.jobId}\` to run its job again.`,
      });
    }
    if (!original.retryable) {
      throw new AiregError(
        `Run ${quoted(runId)} cannot be retried, because running it again would end the same way.`,
        {
          code: ErrorCode.Conflict,
          hint: `Run \`aireg job runs ${runId}\` to see how it ended.`,
        },
      );
    }
    return { run: await this.#runner.start(original.jobId, original.mode, "manual") };
  }

  #emit(event: RunEvent): void {
    this.#server.broadcast("run.event", event);
  }

  #daemonInfo(): DaemonInfo {
    return {
      instanceId: this.#instanceId,
      startedAtMs: this.#startedAtMs,
      serverNowMs: Date.now(),
      ...(this.#closing === undefined ? {} : { stopping: true as const }),
    };
  }

  #busy(): boolean {
    return ACTIVE_RUN_STATES.some((state) => this.#runs.list({ state, limit: 1 }).length > 0);
  }

  async #applyMinUpdate(): Promise<"skip" | "replace"> {
    const hooks = this.#replaceHooks();
    if ((await applyDaemonCliUpdate(hooks)) === "replace") return "replace";
    return applyDaemonAdapterUpdate({
      ...hooks,
      update: (env) =>
        updateAdapters(env, {
          onFailure: (adapter, error) =>
            this.#log.warn("adapter update failed", { adapter, error }),
        }),
    });
  }

  #replaceHooks() {
    return {
      // Closing counts as busy, so the floor and follow checks never both replace.
      busy: () => this.#busy() || this.#closing !== undefined,
      close: () => this.close(),
      start: startDaemon,
      ...(supervised()
        ? {
            restart: async () => {
              this.#exitCode = RESTART_EXIT_CODE;
              await this.close();
            },
          }
        : {}),
    };
  }

  /** Non-zero only when the daemon asks its supervisor to start it again. */
  get exitCode(): number {
    return this.#exitCode;
  }

  async #cancel(raw: unknown): Promise<{ run: RunRecord }> {
    const runId = inputs.text(inputs.object(raw), "runId");
    const run = this.#runner.cancel(runId);
    if (run === undefined) throw noRun(runId);
    return { run };
  }

  async listen(): Promise<void> {
    // A daemon busy starting up can miss the socket probe; its pid file still names it.
    if ((await liveDaemonPid()) !== undefined) throw new DaemonAlreadyRunningError();
    // Owning the endpoint is what makes this the single daemon, so only now
    // is it safe to declare another process's runs dead.
    const endpoint = rpcEndpoint();
    await privateDirectory(dirname(endpoint));
    await this.#server.listen(endpoint);
    await writeDaemonPid(process.pid);
    const abandoned = this.#runs.abandonActive(Date.now());
    this.#log.debug("reclaimed runs left active by a previous process", { abandoned });
    this.#scheduler.start();
    this.#minUpdate.start();
    this.#follow.start();
    // A home deleted under it leaves a daemon nobody can reach or stop.
    const home = toolHome();
    this.#homeWatch = setInterval(() => {
      if (existsSync(home)) return;
      this.#log.warn("aireg's home is gone, so the daemon is stopping", { home });
      void this.close();
    }, HOME_WATCH_MS);
    this.#homeWatch.unref();
  }

  onceStopped(listener: () => void): void {
    if (this.#closing !== undefined) listener();
    else this.#stopped.add(listener);
  }

  async close(): Promise<void> {
    if (this.#closing === undefined) this.#closing = this.#finish();
    await this.#closing;
    const listeners = [...this.#stopped];
    this.#stopped.clear();
    for (const listener of listeners) listener();
  }

  async #finish(): Promise<void> {
    // Unbind last. A replacement that listened during runner.stop() would
    // abandonActive the same rows this process is still finishing.
    clearInterval(this.#homeWatch);
    this.#minUpdate.stop();
    this.#follow.stop();
    this.#scheduler.stop();
    this.#server.drain();
    await this.#runner.stop();
    this.#runs.close();
    await this.#server.close();
    // Only once unbound: a live pid keeps a replacement out while the socket is ours.
    await releaseDaemonPid(process.pid);
  }
}

export async function runDaemon(version: string): Promise<number> {
  const log = openDaemonLog(version);
  installCrashHandlers(log.logger, log.close);
  log.logger.info("daemon starting", { version });

  const runtime = await DaemonRuntime.open(version, log.logger);
  try {
    await runtime.listen();
  } catch (error) {
    await runtime.close();
    // A supervisor restarts a non-zero exit, so a redundant process has to look like success.
    if (error instanceof DaemonAlreadyRunningError) {
      log.logger.info("daemon already running, exiting");
      log.close();
      return 0;
    }
    log.logger.error("daemon failed to listen", { error });
    log.close();
    throw error;
  }
  log.logger.info("daemon listening");
  // Best effort: a definition still running the shim moves to the binary at its next start.
  void refreshAutostart()
    .then((moved) => moved && log.logger.info("autostart now runs the binary directly"))
    .catch((error: unknown) => log.logger.warn("autostart refresh failed", { error }));

  const reason = await new Promise<string>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
    runtime.onceStopped(() => resolve("stopped"));
  });
  await runtime.close();
  log.logger.info("daemon stopped", { reason, exitCode: runtime.exitCode });
  log.close();
  return runtime.exitCode;
}

/**
 * A sync someone runs uses their `AIREG_TOKEN_<NAME>` for the registry it syncs; the
 * daemon's own environment holds none, so a job it runs later cannot reach it.
 */
function withSuppliedToken<T>(params: Fields, work: () => Promise<T>): Promise<T> {
  const token = inputs.optionalText(params, "token");
  if (token === undefined) return work();
  return withRegistryTokens({ [tokenVariable(inputs.text(params, "registry"))]: token }, work);
}
