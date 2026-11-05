import type { Scope } from "#core/store/paths.ts";

interface Watch {
  folder: string;
  /** As `<registry>/<namespace>`. */
  to: string;
  jobId: string;
  scope: Scope;
  root: string;
}

/** `aireg watch list`. */
export interface WatchList {
  watches: Watch[];
}

/** `aireg watch remove` for one job: the folders it still watches. */
export interface WatchRemoved {
  jobId: string;
  watching: string[];
}

/** `aireg watch remove`: one job, or `jobs` when the folders spanned several. */
export type WatchRemoveResult = WatchRemoved | { jobs: WatchRemoved[] };
