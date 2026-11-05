import { gte } from "#adapter/semver.ts";

export function needsMinimumUpdate(current: string, minimum: string | undefined): boolean {
  return minimum !== undefined && !gte(current, minimum);
}
