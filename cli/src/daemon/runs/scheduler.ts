import { stat } from "node:fs/promises";
import type { Job, RegistryConfig } from "#core/config/model.ts";
import { configPath, readConfig } from "#core/config/repository.ts";
import { steadyStepKinds } from "#core/host/load.ts";
import { nullLogger } from "#core/log/logger.ts";
import type { Logger } from "#core/log/model.ts";
import { ACTIVE_RUN_STATES, isActive, type RunTrigger } from "#core/run/model.ts";
import { MAX_PAGE_SIZE, type RunStore } from "#core/run/store.ts";
import { dueAt, QUIET_LOOKBACK, retryBackoff } from "./failure.ts";
import type { SyncRunner } from "./runner.ts";

const TICK_MS = 1_000;

/**
 * How many scheduled runs go at once. Jobs exist per kind and per account, so a
 * person in several organisations has dozens, and every run shares this process's
 * one thread with the RPC server: started all together they left the daemon unable
 * to answer, with runs that take seconds taking minutes and reads timing out. A run
 * a person started (`manual`) does not count, and is never held back.
 */
const MAX_SCHEDULED_RUNS = 4;

/** A start that throws writes no run row, so its backoff has to live here. */
interface Deferral {
  attempts: number;
  nextAttemptAtMs: number;
}

export class JobScheduler {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #deferred = new Map<string, Deferral>();
  readonly #runs: RunStore;
  readonly #runner: SyncRunner;
  readonly #log: Logger;
  readonly #steadyKinds: () => Promise<ReadonlySet<string>>;
  #config: { stamp: string; value: RegistryConfig } | undefined;

  constructor(
    runs: RunStore,
    runner: SyncRunner,
    log: Logger = nullLogger(),
    steadyKinds: () => Promise<ReadonlySet<string>> = steadyStepKinds,
  ) {
    this.#runs = runs;
    this.#runner = runner;
    this.#log = log;
    this.#steadyKinds = steadyKinds;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const { config, changed } = await this.#readConfig();
      // Bookkeeping, so it runs whether or not the scheduler may start anything.
      if (changed) {
        const live = new Set(config.jobs.map(({ id }) => id));
        for (const id of this.#deferred.keys()) if (!live.has(id)) this.#deferred.delete(id);
        this.#runs.forgetJobs(live);
      }
      if (config.paused) return;
      if (this.#scheduledRunsGoing() >= MAX_SCHEDULED_RUNS) return;
      const steady = await this.#steadyKinds();
      const now = Date.now();
      // Longest-waiting first, so the cap never starves the jobs late in the file.
      // The sort is stable: jobs due at the same moment keep their order.
      const due = config.jobs
        .filter((job) => job.schedule.enabled)
        .flatMap((job) => {
          const found = this.#dueSince(job, steady, now);
          return found === undefined ? [] : [{ job, ...found }];
        })
        .sort((left, right) => left.at - right.at);
      for (const { job, trigger } of due) {
        // Resuming leaves every held-back job overdue, so a started run ends the tick;
        // a failed start does not, or one broken job spends it.
        if (await this.#start(job.id, trigger, now)) break;
      }
    } catch (error) {
      this.#log.error("scheduler tick failed", { error });
    } finally {
      this.#ticking = false;
    }
  }

  async #readConfig(): Promise<{ config: RegistryConfig; changed: boolean }> {
    const stamp = await stat(configPath()).then(
      (info) => `${info.mtimeMs}:${info.size}:${info.ino}`,
      () => "absent",
    );
    if (this.#config?.stamp === stamp) return { config: this.#config.value, changed: false };
    const value = await readConfig();
    this.#config = { stamp, value };
    return { config: value, changed: true };
  }

  /** Scheduled runs in flight. A run a person started is never counted. */
  #scheduledRunsGoing(): number {
    return ACTIVE_RUN_STATES.flatMap((state) =>
      this.#runs.list({ state, limit: MAX_PAGE_SIZE }),
    ).filter((run) => run.trigger !== "manual").length;
  }

  /** When `job` fell due, or undefined while it backs off, runs, or is not due yet. */
  #dueSince(
    job: Job,
    steady: ReadonlySet<string>,
    now: number,
  ): { at: number; trigger: RunTrigger } | undefined {
    if ((this.#deferred.get(job.id)?.nextAttemptAtMs ?? 0) > now) return undefined;
    const recent = this.#runs.list({ jobId: job.id, limit: QUIET_LOOKBACK });
    const latest = recent.at(0);
    if (latest !== undefined && isActive(latest.state)) return undefined;
    const keepsInterval = job.steps.some((step) => steady.has(step.kind));
    const at = dueAt(job, recent, keepsInterval, now);
    if (at > now) return undefined;
    return { at, trigger: latest === undefined ? "startup" : "schedule" };
  }

  async #start(jobId: string, trigger: RunTrigger, now: number): Promise<boolean> {
    try {
      await this.#runner.start(jobId, "sync", trigger);
      this.#deferred.delete(jobId);
      return true;
    } catch (error) {
      // No run row is written for a start that throws, so this is the only record of why.
      this.#log.warn("job could not be started", {
        jobId,
        mode: "sync",
        attempts: (this.#deferred.get(jobId)?.attempts ?? 0) + 1,
        error,
      });
      this.#defer(jobId, now);
      return false;
    }
  }

  #defer(jobId: string, now: number): void {
    const attempts = (this.#deferred.get(jobId)?.attempts ?? 0) + 1;
    this.#deferred.set(jobId, { attempts, nextAttemptAtMs: now + retryBackoff(attempts) });
  }
}
