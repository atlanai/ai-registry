import type { Scope } from "#core/store/paths.ts";

interface Item {
  name: string;
  /** The target folder it was moved out of, such as `claude-code`. */
  target: string;
  /** The folder within the target, such as `skills`. */
  dir: string;
  /** Where it is now. */
  path: string;
  /** Where it was, when aireg can tell. */
  origin?: string;
}

interface Run {
  stamp: string;
  /** When it ran, as an ISO 8601 time, when the stamp is one. */
  at?: string;
  /** Items per target. */
  counts: Record<string, number>;
  items: Item[];
}

/** `aireg backup list`. */
export interface BackupList {
  scope: Scope;
  /** The scope's backups folder. */
  root: string;
  runs: Run[];
}

/** Why an item stayed in backups. */
export const SKIP_REASONS = ["kept", "taken", "installed", "refused", "unknown"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** `aireg backup restore`. */
export interface BackupRestore {
  scope: Scope;
  stamp: string;
  restored: { name: string; target: string; path: string; replaced?: string }[];
  skipped: { name: string; target: string; path?: string; reason: SkipReason; detail?: string }[];
}
