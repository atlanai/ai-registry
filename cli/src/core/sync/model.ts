import type { ArtifactKind } from "#adapter/kinds.ts";

/** Derived from three digests, never stored, so it cannot disagree with the bytes on disk. */
export const DISPOSITIONS = [
  "synced",
  "pull",
  // The registry removed bytes that are unchanged here.
  "pull-delete",
  "publish",
  "conflict",
  // Here and publishable, but no registry publishes it.
  "adopt",
  // Deleted here while the registry still holds the base.
  "archive",
  // Both sides deleted the content represented by the base.
  "removed",
  // No base, so neither side can be shown to have moved.
  "unknown",
  // The registry advertises it but would not serve it.
  "unavailable",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

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
   * What the registry published at the locked revision, not what we placed:
   * after a settled conflict that reads as unchanged against itself.
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
  /** File spec address, POSIX separators. */
  path: string;
  disposition: Disposition;
  digests: Digests;
  detail: string | undefined;
  /** Present only when unavailable. */
  failure?: { code: string; retryable: boolean };
}
