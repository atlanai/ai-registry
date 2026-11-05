export interface RemoveResult {
  dryRun: boolean;
  /** One another artifact still needs stays installed and is not listed. */
  removed: string[];
  /** Dependencies removed with them. */
  pruned: string[];
  /** Kept because a job publishes them from the person's own folders. */
  watched: string[];
}
