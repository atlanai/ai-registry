import { compareVersion, formatVersion, gte, parseVersion } from "#adapter/semver.ts";
import { isRecord } from "./fields.ts";
import { NAME } from "./product.ts";

/** `0.3.0`, `>=0.3.0` and `>=v0.3.0` all mean this version or newer. Ranges are refused. */
export function parseEngine(raw: string): string | undefined {
  const trimmed = raw.trim();
  const body = trimmed.startsWith(">=") ? trimmed.slice(2).trim() : trimmed;
  // npm's engines take `v0.3.0` too, so the shared strict parser gets it bare.
  const version = parseVersion(body.replace(/^v(?=\d)/, ""));
  if (version === undefined || version.prerelease.length > 0) return undefined;
  return formatVersion(version);
}

export function engineFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return parseEngine(value);
  return isRecord(value) ? engineFromUnknown(value[NAME]) : undefined;
}

export function unmetEngine(current: string, engine: string | undefined): string | undefined {
  if (engine === undefined) return undefined;
  const min = parseEngine(engine);
  if (min === undefined) return undefined;
  if (gte(current, min)) return undefined;
  return `needs aireg ${min} or later; this CLI is ${current}`;
}

/** Strictly older by SemVer precedence; false when either is not a version. */
export function olderThan(version: string | undefined, than: string | undefined): boolean {
  const [left, right] = [parseVersion(version ?? ""), parseVersion(than ?? "")];
  return left !== undefined && right !== undefined && compareVersion(left, right) < 0;
}
