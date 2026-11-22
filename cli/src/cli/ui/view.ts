import { homedir } from "node:os";
import type { KeptArtifact, PageState } from "./page-state.ts";
import type { UiArtifact, UiState } from "./protocol.ts";

/** A problem is prose that may quote a path; only `~` leaves this machine's names out. */
function homeless(text: string): string {
  const home = homedir();
  return home.length > 1 ? text.split(home).join("~") : text;
}

function artifactOf(artifact: KeptArtifact): UiArtifact {
  const { copy: _copy, installedKey, local: _local, ...shown } = artifact;
  return { ...shown, detail: homeless(shown.detail), removable: installedKey !== undefined };
}

/** What the page sees: everything the server read, minus where it is on disk. */
export function viewOf(state: PageState): UiState {
  const { console } = state;
  const names = new Map(console.jobs.map((job) => [job.id, job.name]));
  return {
    artifacts: state.artifacts.map(artifactOf),
    registries: state.registries,
    scope: console.scope,
    root: console.root,
    daemon: {
      running: console.daemon.running,
      detail: `${console.daemon.jobsEnabled} of ${console.daemon.jobsTotal} jobs enabled`,
    },
    jobs: console.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      intervalSeconds: job.intervalSeconds,
      nextRunAtMs: job.nextRunAtMs,
    })),
    runs: console.runs.map((run) => ({
      id: run.id,
      label: (run.jobId === undefined ? undefined : names.get(run.jobId)) ?? run.mode,
      state: run.state,
      startedAtMs: run.requestedAtMs,
      endedAtMs: run.finishedAtMs,
      error: run.reason === undefined ? run.errorCode : homeless(run.reason),
    })),
    problems: state.problems.map(homeless),
    readAtMs: state.readAtMs,
    version: console.version,
  };
}
