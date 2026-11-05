import type { ArtifactKind } from "#adapter/kinds.ts";

export interface SearchMatch {
  /** What `aireg add` takes for it. */
  address: string;
  registry: string;
  namespace?: string;
  kind: ArtifactKind;
  name: string;
  version?: string;
  description?: string;
  /** The spec's indexable string pairs, used as tags. */
  labels?: Record<string, string>;
}

/** A registry that could not be read, which the search went on without. */
export interface SkippedRegistry {
  registry: string;
  message: string;
}

/** Matches best first. */
export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  skipped: SkippedRegistry[];
}
