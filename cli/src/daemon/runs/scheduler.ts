import { stat } from "node:fs/promises";
import type { Job, RegistryConfig } from "#core/config/model.ts";
import { configPath, readConfig } from "#core/config/repository.ts";
import { steadyStepKinds } from "#core/host/load.ts";
import { nullLogger } from "#core/log/logger.ts";
import type { Logger } from "#core/log/model.ts";
import { isActive } from "#core/run/model.ts";
import type { RunStore } from "#core/run/store.ts";
import { dueAt, QUIET_LOOKBACK, retryBackoff } from "./failure.ts";
import type { SyncRunner } from "./runner.ts";

const TICK_MS = 1_000;

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
      const steady = await this.#steadyKinds();
      for (const job of config.jobs) {
        if (!job.schedule.enabled) continue;
        // Resuming leaves every held-back job overdue, so a started run ends the tick;
        // a failed start does not, or one broken job spends it.
        if (await this.#consider(job, steady)) break;
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

  async #consider(job: Job, steady: ReadonlySet<string>): Promise<boolean> {
    const jobId = job.id;
    const now = Date.now();
    if ((this.#deferred.get(jobId)?.nextAttemptAtMs ?? 0) > now) return false;
    const recent = this.#runs.list({ jobId, limit: QUIET_LOOKBACK });
    const latest = recent.at(0);
    if (latest !== undefined && isActive(latest.state)) return false;
    const keepsInterval = job.steps.some((step) => steady.has(step.kind));
    if (dueAt(job, recent, keepsInterval, now) > now) return false;
    try {
      await this.#runner.start(jobId, "sync", latest === undefined ? "startup" : "schedule");
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
