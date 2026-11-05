import type { Job } from "#core/config/model.ts";
import type { RunEvent, RunRecord } from "#core/run/model.ts";

export interface JobSaved {
  job: Job;
  revision: number;
}

export interface JobList {
  paused: boolean;
  jobs: readonly Job[];
}

export interface JobRemoved {
  jobId: string;
}

/** `aireg job enable` and `disable`. */
export interface JobToggled {
  jobId: string;
  enabled: boolean;
}

/** `aireg job pause` and `resume`. */
export interface JobsPaused {
  paused: boolean;
  revision: number;
}

/** `aireg job start`, `retry` and `cancel`. */
export interface JobRun {
  run: RunRecord;
}

/** `aireg job runs`: newest first. */
export interface RunList {
  runs: RunRecord[];
}

/** `aireg job runs <run>`. */
export interface RunDetail {
  run: RunRecord;
  events: RunEvent[];
}
