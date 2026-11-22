import { useSyncExternalStore } from "react";

export interface LiveRun {
  lines: string[];
  end: { ok: boolean; exitCode: number | null; summary: string } | undefined;
}

/** Enough scrollback for any real run, bounded so a chatty one cannot exhaust the tab. */
const MOST_LINES = 5000;
const runs = new Map<string, LiveRun>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

function entry(runId: string): LiveRun {
  let run = runs.get(runId);
  if (run === undefined) {
    run = { lines: [], end: undefined };
    runs.set(runId, run);
  }
  return run;
}

export function addLine(runId: string, line: string): void {
  const run = entry(runId);
  const lines = [...run.lines, line];
  runs.set(runId, { ...run, lines: lines.length > MOST_LINES ? lines.slice(-MOST_LINES) : lines });
  changed();
}

export function endRun(runId: string, end: NonNullable<LiveRun["end"]>): void {
  runs.set(runId, { ...entry(runId), end });
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveRun(runId: string | undefined): LiveRun | undefined {
  return useSyncExternalStore(subscribe, () => (runId === undefined ? undefined : runs.get(runId)));
}

/** Re-renders on any run change; for lists of runs. */
export function useRunsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function liveRun(runId: string): LiveRun | undefined {
  return runs.get(runId);
}
