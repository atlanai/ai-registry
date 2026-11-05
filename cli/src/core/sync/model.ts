import type { ArtifactKind } from "#adapter/kinds.ts";

/**
 * Derived from three digests, never from a flag anyone stored: a disposition
 * that could be written down could also disagree with the bytes on disk.
 */
export const DISPOSITIONS = [
  "synced",
  "pull",
  // The registry removed bytes that are unchanged here.
  "pull-delete",
  "publish",
  "conflict",
  "adopt",
  "archive",
  "removed",
  // No base, so neither side can be shown to have moved.
  "unknown",
  // The registry advertises it but would not serve it.
  "unavailable",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/** Every disposition that leaves the project and the registry disagreeing. */
export const UNSETTLED: readonly Disposition[] = DISPOSITIONS.filter(
  (disposition) => disposition !== "synced",
);

/** What a pull-only run acts on, beyond what every run looks at. */
export const PULL_DISPOSITIONS: readonly Disposition[] = ["pull", "pull-delete", "removed"];

/** What a publish-only run acts on, beyond what every run looks at. */
export const PUBLISH_DISPOSITIONS: readonly Disposition[] = [
  "publish",
  "adopt",
  "archive",
  "removed",
];

export interface Digests {
  /**
   * What the registry published at the revision the lock pins - not what we
   * placed, which after a settled conflict reads as unchanged against itself.
   */
  base: string | undefined;
  local: string | undefined;
  upstream: string | undefined;
}

export interface SyncItem {
  name: string;
  kind: ArtifactKind;
  /** Key into the lock's `registries`. */
  source: string;
  /** The artifact's file spec address in the registry, POSIX separators. */
  path: string;
  disposition: Disposition;
  digests: Digests;
  detail: string | undefined;
  /** Why this one item could not be read. Present only when unavailable. */
  failure?: { code: string; retryable: boolean };
}
