import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isRecord, textOf } from "#adapter/fields.ts";
import { sanitizeText } from "#adapter/text.ts";
import type { Job, RegistryConfig } from "#core/config/model.ts";
import { isRaw, parseLine } from "#core/log/read.ts";
import { DAEMON_LOG_FILE, logPath } from "#core/log/sink.ts";
import {
  type ItemOutcome,
  isTerminal,
  type RunEvent,
  RunEventType,
  type RunMode,
  type RunRecord,
} from "#core/run/model.ts";
import { toolHome } from "#core/store/paths.ts";
import type { UpstreamFacts } from "./artifacts.ts";
import type { JobRow, RunRow } from "./model.ts";

/** Finished runs only: one still going reports `examined: 0`. */
export function newestFinished(runs: readonly RunRecord[], mode?: RunMode): RunRecord | undefined {
  return runs
    .filter((run) => (mode === undefined || run.mode === mode) && isTerminal(run.state))
    .sort((left, right) => right.requestedAtMs - left.requestedAtMs)[0];
}

/**
 * What the registry refused, and what it has not approved yet: an artifact
 * the catalog lost is not on disk, so nothing else would report it at all.
 */
export function upstreamFacts(events: readonly RunEvent[]): UpstreamFacts {
  const failed = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    const name = event.artifact;
    if (name === undefined) continue;
    if (event.errorCode !== undefined) {
      failed.set(name, shown(textOf(field(event, "detail"))) ?? event.errorCode);
      continue;
    }
    // A publish that lands for review is reported as settled, not as changed; an
    // edit that was only reported was never sent, so it is not waiting on anyone.
    if (
      event.disposition === "publish" &&
      event.operation === "publish" &&
      event.outcome === "attention"
    ) {
      pending.add(name);
    }
  }
  return { failed, pending };
}

/** A registry or adapter wrote this text, so it is printed only once it cannot drive the terminal. */
function shown(text: string | undefined): string | undefined {
  return text === undefined ? undefined : sanitizeText(text, 2000);
}

function field(event: RunEvent, name: string): unknown {
  return isRecord(event.data) ? event.data[name] : undefined;
}

/** A job that settled a local folder, and why it is held if it is. */
export interface Carrier {
  job: string;
  jobId: string;
  /** When that run finished; a folder edited after it has changes the job has not taken. */
  settledAtMs: number | undefined;
  outcome: ItemOutcome | undefined;
  detail: string | undefined;
}

const CARRIED = new Set<ItemOutcome | undefined>(["changed", "unchanged", "attention"]);

/**
 * Folders a job's items name in `data.paths`, by path. The bag is the adapter's
 * own, so anything but an array of strings is ignored.
 */
export function carriedPaths(
  runs: readonly {
    job: string;
    jobId: string;
    settledAtMs: number | undefined;
    events: readonly RunEvent[];
  }[],
): Map<string, Carrier> {
  const found = new Map<string, Carrier>();
  for (const { job, jobId, settledAtMs, events } of runs) {
    for (const event of events) {
      if (event.eventType !== RunEventType.ItemSettled || event.errorCode !== undefined) continue;
      if (!CARRIED.has(event.outcome)) continue;
      const paths = field(event, "paths");
      if (!Array.isArray(paths)) continue;
      const carrier = {
        job,
        jobId,
        settledAtMs,
        outcome: event.outcome,
        detail: shown(textOf(field(event, "detail"))),
      };
      for (const path of paths) {
        if (typeof path === "string" && path !== "" && !found.has(path)) found.set(path, carrier);
      }
    }
  }
  return found;
}

/**
 * The prose behind a `sync_failed`. The run record carries only the code, so
 * the console reads the daemon's own log for the message beside that run id.
 */
export async function failureReasons(
  ids: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (ids.size === 0) return found;
  const wanted = [...ids];
  const lines = createInterface({
    input: createReadStream(logPath(toolHome(env), DAEMON_LOG_FILE), "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    // Newest last, and a later line for the same run is the better answer.
    for await (const line of lines) {
      // The log runs to megabytes and few lines name a failed run, so only
      // those are parsed.
      if (!wanted.some((id) => line.includes(id))) continue;
      const entry = parseLine(line);
      if (entry === undefined || isRaw(entry)) continue;
      const runId = entry.attributes.runId;
      if (typeof runId !== "string" || !ids.has(runId)) continue;
      if (entry.severity_text !== "error" && entry.severity_text !== "fatal") continue;
      found.set(runId, sanitizeText(entry.error?.message ?? entry.body, 2000));
    }
  } catch {
    // No log yet, or one rotated away underneath: the rows say what they can.
  } finally {
    lines.close();
  }
  return found;
}

export function runRows(
  runs: readonly RunRecord[],
  reasons: ReadonlyMap<string, string>,
): RunRow[] {
  return runs.map((run) => ({
    id: run.id,
    jobId: run.jobId,
    mode: run.mode,
    trigger: run.trigger,
    state: run.state,
    requestedAtMs: run.requestedAtMs,
    finishedAtMs: run.finishedAtMs,
    counts: run.counts,
    errorCode: run.errorCode,
    reason: reasons.get(run.id),
  }));
}

export function jobRows(config: RegistryConfig, runs: readonly RunRecord[]): JobRow[] {
  return config.jobs.map((job) => {
    const mine = runs
      .filter((run) => run.jobId === job.id)
      .sort((left, right) => right.requestedAtMs - left.requestedAtMs);
    const last = mine[0]?.requestedAtMs;
    return {
      id: job.id,
      name: job.name ?? job.id,
      type: job.steps.map((step) => step.kind).join("+"),
      accountId: job.account,
      enabled: job.schedule.enabled,
      intervalSeconds: job.schedule.every,
      summary: summaryOf(job),
      lastRunAtMs: last,
      nextRunAtMs:
        last === undefined || !job.schedule.enabled || config.paused
          ? undefined
          : last + job.schedule.every * 1_000,
    };
  });
}

function summaryOf(job: Job): string {
  return job.steps.map((step) => `${step.name}:${step.kind}`).join(" \u2192 ");
}
