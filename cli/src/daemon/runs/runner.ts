import { randomUUID } from "node:crypto";
import { AccountService } from "#accounts/service.ts";
import { quoted } from "#adapter/text.ts";
import { stopGit } from "#adapters/git/api.ts";
import { expandSteps, orderSteps } from "#core/config/jobs.ts";
import {
  type Account,
  isScopeStep,
  type Job,
  type RegistryConfig,
  type Step,
} from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import type { StepRunResult } from "#core/host/extend.ts";
import { stepContribution, stepOn } from "#core/host/load.ts";
import { nullLogger } from "#core/log/logger.ts";
import type { Logger } from "#core/log/model.ts";
import {
  EMPTY_RUN_COUNTS,
  type ItemSettled,
  isActive,
  type RunCounts,
  type RunEvent,
  RunEventType,
  type RunMode,
  type RunRecord,
  type RunTrigger,
  type TerminalRunState,
} from "#core/run/model.ts";
import type { CreateRun, RunStore } from "#core/run/store.ts";
import { scopeFor, userScopeDir } from "#core/store/paths.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import { policyOf } from "#core/sync/policy.ts";
import { settledWithin } from "#core/wait.ts";
import { extensionHost } from "#daemon/extension-host.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ProtocolError } from "#daemon/rpc/protocol.ts";
import type { SyncExecutionHooks } from "#engine/sync/decide.ts";
import { executeSync } from "#engine/sync/execute.ts";
import type { RunScope } from "#engine/sync/narrow.ts";
import type { ScopeWork } from "#engine/sync/work.ts";
import { CANCELED, classifyFailure, SHUTDOWN, TIMED_OUT } from "./failure.ts";

/** Which terminal state wins when steps disagree. */
const WORSE = {
  succeeded: 0,
  attention: 1,
  partial: 2,
  canceled: 3,
  timed_out: 4,
  failed: 5,
  abandoned: 6,
} as const satisfies Record<TerminalRunState, number>;

const RUN_TIMEOUT_MS = 30 * 60 * 1_000;
/**
 * How long a run may ignore its abort before it is settled without it. Code that never checks
 * its signal would otherwise hold the run, and its job, for good.
 */
const ABORT_GRACE_MS = 30 * 1_000;
/** How long stopping waits for runs to wind down before the daemon goes anyway. */
const STOP_GRACE_MS = 15 * 1_000;

/** A failed run still reports what got through, so the counters outlive the hooks. */
interface Tally {
  step: string;
  changed: number;
}

interface Target {
  job: Job;
  account: Account;
}

interface RunOptions {
  /** Narrows this run only; the job covers what its manifest declares. */
  refs?: RunScope;
  /** Forces one artifact's operation, so a resolved conflict is an ordinary run. */
  overrides?: ReadonlyMap<string, SyncOperation>;
  /**
   * A job built for this run alone. It is never persisted, so the run records
   * no job id and the one-live-run-per-job index leaves it alone.
   */
  ephemeral?: Target;
}

/**
 * What a one-off run was asked to do, without the id made up for it, so the
 * same request made twice is recognized as one.
 */
function oneOffKey(
  { job, account }: Target,
  mode: RunMode,
  refs: RunScope,
  overrides: ReadonlyMap<string, SyncOperation> | undefined,
): string {
  return JSON.stringify([
    account.id,
    mode,
    job.steps,
    refs === undefined ? null : [...refs].sort(),
    [...(overrides ?? [])].sort(),
  ]);
}

function resolveTarget(config: RegistryConfig, jobId: string): Target {
  const job = config.jobs.find(({ id }) => id === jobId);
  if (job === undefined) {
    throw new ProtocolError(RpcErrorCode.NotFound, `No job named ${quoted(jobId)}.`);
  }
  const account = config.accounts.find(({ id }) => id === job.account);
  if (account === undefined) {
    throw new ProtocolError(
      RpcErrorCode.NotFound,
      `Job ${quoted(job.id)} signs in with account ${quoted(job.account)}, which no longer exists.`,
    );
  }
  return { job, account };
}

export class SyncRunner {
  readonly #controllers = new Map<string, AbortController>();
  readonly #workers = new Map<string, Promise<void>>();
  /** The live run behind each one-off request, which has no job to hold it to one. */
  readonly #oneOff = new Map<string, string>();
  readonly #store: RunStore;
  readonly #emit: (event: RunEvent) => void;
  readonly #version: string;
  readonly #log: Logger;

  constructor(
    store: RunStore,
    emit: (event: RunEvent) => void,
    version = "0.0.0-dev",
    log: Logger = nullLogger(),
  ) {
    this.#store = store;
    this.#emit = emit;
    this.#version = version;
    this.#log = log;
  }

  async start(
    jobId: string,
    mode: RunMode,
    trigger: RunTrigger,
    { refs, overrides, ephemeral }: RunOptions = {},
  ): Promise<RunRecord> {
    const config = await readConfig();
    const { job, account } = ephemeral ?? resolveTarget(config, jobId);
    // One live run per job is a unique index, so a repeated request joins the
    // run already in flight rather than needing an idempotency key of its own.
    const existing = ephemeral === undefined ? this.#store.activeJob(jobId) : undefined;
    if (existing !== undefined && existing.mode === mode) return existing;
    if (existing !== undefined) {
      throw new ProtocolError(
        RpcErrorCode.Busy,
        `A ${existing.mode} run of job ${quoted(jobId)} is already running.`,
      );
    }
    // A one-off run gets a fresh job id the index never sees, so a repeated `aireg sync` joins
    // the run doing it rather than queuing another full scan behind the same lease.
    const asked = ephemeral === undefined ? undefined : oneOffKey(ephemeral, mode, refs, overrides);
    const joined = asked === undefined ? undefined : this.#store.get(this.#oneOff.get(asked) ?? "");
    if (joined !== undefined && isActive(joined.state)) return joined;
    const now = Date.now();
    const input: CreateRun = {
      id: `run_${randomUUID()}`,
      ...(ephemeral === undefined ? { jobId } : {}),
      accountId: account.id,
      configRevision: config.revision,
      mode,
      trigger,
      requestedAtMs: now,
      deadlineAtMs: now + RUN_TIMEOUT_MS,
    };
    const run = this.#store.create(input);
    this.emitLast(run.id);
    if (asked !== undefined) this.#oneOff.set(asked, run.id);
    const worker = this.execute(run, job, account, refs, overrides);
    this.#workers.set(run.id, worker);
    void worker
      .finally(() => {
        this.#workers.delete(run.id);
        if (asked !== undefined && this.#oneOff.get(asked) === run.id) this.#oneOff.delete(asked);
      })
      .catch(() => {});
    return run;
  }

  cancel(runId: string): RunRecord | undefined {
    const run = this.#store.get(runId);
    if (run === undefined || !isActive(run.state)) return run;
    this.#controllers.get(runId)?.abort(CANCELED);
    return this.#store.get(runId);
  }

  async stop(): Promise<void> {
    for (const controller of this.#controllers.values()) controller.abort(SHUTDOWN);
    // A git started without the run's signal would otherwise hold the stop open.
    stopGit();
    await settledWithin(this.#workers.values(), STOP_GRACE_MS);
  }

  private event(
    runId: string,
    type: RunEventType,
    step: string,
    artifact?: string,
    data?: unknown,
  ): void {
    const recorded = this.#store.progress(runId, step, {
      occurredAtMs: Date.now(),
      eventType: type,
      step,
      ...(artifact === undefined ? {} : { artifact }),
      ...(data === undefined ? {} : { data }),
    });
    if (recorded !== undefined) this.#emit(recorded);
  }

  private item(
    runId: string,
    artifact: string,
    step: string,
    settled: ItemSettled,
    data?: unknown,
  ): void {
    const recorded = this.#store.progress(runId, step, {
      occurredAtMs: Date.now(),
      eventType: RunEventType.ItemSettled,
      step,
      artifact,
      ...settled,
      ...(data === undefined ? {} : { data }),
    });
    if (recorded !== undefined) this.#emit(recorded);
  }

  private emitLast(runId: string): void {
    const last = this.#store.lastEvent(runId);
    if (last !== undefined) this.#emit(last);
  }

  private async execute(
    run: RunRecord,
    job: Job,
    account: Account,
    refs: RunScope,
    overrides: ReadonlyMap<string, SyncOperation> | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    const tally: Tally = { step: "starting", changed: 0 };
    let watchdog: NodeJS.Timeout | undefined;
    const timer = setTimeout(
      () => {
        controller.abort(TIMED_OUT);
        watchdog = setTimeout(() => {
          this.finishFailure(run, job, controller.signal, TIMED_OUT, {
            ...EMPTY_RUN_COUNTS,
            changed: tally.changed,
            failed: 1,
          });
          // Forgotten, not awaited: whatever ignored the abort may never return.
          this.#controllers.delete(run.id);
          this.#workers.delete(run.id);
        }, ABORT_GRACE_MS);
        watchdog.unref();
      },
      Math.max(0, run.deadlineAtMs - Date.now()),
    );
    const startedAtMs = Date.now();
    const log = this.#log.child({
      runId: run.id,
      jobId: job.id,
      mode: run.mode,
      trigger: run.trigger,
    });
    try {
      this.#store.start(run.id, "starting", startedAtMs);
      log.info("run started");
      this.emitLast(run.id);
      const result = await this.run(run, job, account, refs, overrides, controller, tally);
      if (controller.signal.aborted) {
        this.finishFailure(run, job, controller.signal, controller.signal.reason, result.counts);
        return;
      }
      if (!this.running(run.id)) return;
      const settled = Date.now();
      this.#store.finish(run.id, {
        state: result.state,
        finishedAtMs: settled,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
      });
      log.info("run finished", { state: result.state, durationMs: settled - startedAtMs });
      this.emitLast(run.id);
    } catch (error) {
      this.finishFailure(run, job, controller.signal, error, {
        ...EMPTY_RUN_COUNTS,
        changed: tally.changed,
        failed: 1,
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(watchdog);
      this.#controllers.delete(run.id);
    }
  }

  private async run(
    run: RunRecord,
    job: Job,
    account: Account,
    refs: RunScope,
    overrides: ReadonlyMap<string, SyncOperation> | undefined,
    controller: AbortController,
    tally: Tally,
  ): Promise<StepRunResult> {
    const hooks = this.hooks(run.id, tally);
    const ordered = orderSteps(expandSteps(job.steps));
    if ("cycle" in ordered) {
      throw new Error(
        `Job ${quoted(job.id)} has steps that wait on each other: ${ordered.cycle.join(" → ")}.`,
      );
    }

    // One pass rather than three: a publish that followed a separate pull would
    // read a tree the pull had already moved.
    const scoped = ordered.order.filter(isScopeStep);
    const adapters = ordered.order.filter((step) => !isScopeStep(step));

    let counts = { ...EMPTY_RUN_COUNTS };
    let state: TerminalRunState = "succeeded";
    let errorCode: string | undefined;
    let retryable: boolean | undefined;

    const root = scoped.find((step: Step) => step.root !== undefined)?.root ?? userScopeDir();
    const scope = scopeFor(root);
    if (scoped.length > 0) {
      const work: ScopeWork = {
        id: job.id,
        root,
        scope,
        account: account.id,
        policy: policyOf(scoped),
        steps: scoped,
      };
      const result = await executeSync(
        work,
        account,
        run.mode,
        refs,
        controller.signal,
        hooks,
        overrides,
      );
      counts = result.counts;
      state = result.state;
      errorCode = result.errorCode;
      retryable = result.retryable;
    }

    for (const step of adapters) {
      if (controller.signal.aborted) break;
      const accounts = new AccountService();
      const resolved = await accounts.resolve(account, scope, root);
      const handler = stepOn(resolved.adapter, step.kind) ?? (await stepContribution(step.kind));
      if (handler === undefined) {
        throw new Error(
          `No installed adapter runs ${quoted(step.kind)} steps. Install one with \`aireg adapter install\`.`,
        );
      }
      const result = await handler.run({
        step,
        account,
        store: this.#store,
        runId: run.id,
        version: this.#version,
        signal: controller.signal,
        hooks,
        host: extensionHost(this.#version),
      });
      counts = {
        examined: counts.examined + result.counts.examined,
        changed: counts.changed + result.counts.changed,
        skipped: counts.skipped + result.counts.skipped,
        attention: counts.attention + result.counts.attention,
        failed: counts.failed + result.counts.failed,
      };
      if (WORSE[result.state] > WORSE[state]) {
        state = result.state;
        errorCode = result.errorCode;
        retryable = result.retryable;
      }
    }

    return {
      counts,
      state,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(retryable === undefined ? {} : { retryable }),
    };
  }

  private hooks(runId: string, tally: Tally): SyncExecutionHooks {
    return {
      event: (type, nextPhase, artifact, data) => {
        tally.step = nextPhase;
        // The run store keeps these as rows; at debug they also narrate the
        // run in the log, beside the failure that ended it.
        this.#log.debug("sync event", { runId, type, phase: nextPhase, artifact });
        this.event(runId, type, nextPhase, artifact, data);
      },
      item: (artifact, phase, settled, data) => {
        tally.step = phase;
        if (settled.outcome === "changed") tally.changed += 1;
        this.item(runId, artifact, phase, settled, data);
      },
    };
  }

  /** A run someone canceled must not be written again by the worker still in flight. */
  private running(runId: string): boolean {
    const current = this.#store.get(runId);
    return current !== undefined && isActive(current.state);
  }

  private finishFailure(
    run: RunRecord,
    job: Job,
    signal: AbortSignal,
    error: unknown,
    counts: RunCounts,
  ): void {
    if (!this.running(run.id)) return;
    const failure = classifyFailure(error, signal.reason, counts.changed);
    // The store keeps `errorCode` and nothing else, so unless the cause is
    // written here it is gone the moment this returns.
    this.#log[failure.interrupted ? "warn" : "error"]("run failed", {
      runId: run.id,
      jobId: job.id,
      mode: run.mode,
      trigger: run.trigger,
      state: failure.state,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      error,
    });
    this.#store.finish(run.id, {
      state: failure.state,
      finishedAtMs: Date.now(),
      errorCode: failure.errorCode,
      retryable: failure.retryable,
    });
    this.emitLast(run.id);
  }
}
