import type { Bump } from "#adapter/semver.ts";

export interface Own extends Record<string, unknown> {
  to?: string;
  bump?: Bump;
  message?: string;
  "changed-since"?: string;
}
