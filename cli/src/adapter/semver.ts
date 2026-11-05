/** SemVer as the file spec orders versions: what is newest, and what comes next. */

/** A parsed SemVer version. Build metadata is dropped, since it never orders. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

const NUMBER = String.raw`0|[1-9]\d*`;
const PRE_IDENT = String.raw`(?:${NUMBER}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const CORE = new RegExp(
  String.raw`^(${NUMBER})\.(${NUMBER})\.(${NUMBER})` +
    String.raw`(?:-(${PRE_IDENT}(?:\.${PRE_IDENT})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

/** A SemVer 2.0.0 version: no leading `v` or leading zeros; undefined for anything else. */
export function parseVersion(input: string): Version | undefined {
  const match = CORE.exec(input.trim());
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n))) return undefined;
  return {
    major,
    minor,
    patch,
    prerelease: match[4] === undefined || match[4] === "" ? [] : match[4].split("."),
  };
}

/** The version written back as `major.minor.patch[-prerelease]`. */
export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join(".")}`;
}

export const BUMPS = ["patch", "minor", "major"] as const;
/** Which part of the version a release moves. */
export type Bump = (typeof BUMPS)[number];

/** The next release after `current`; nothing published yet is `0.1.0`. */
export function bumpVersion(current: string | undefined, how: Bump = "patch"): string {
  const parsed = current === undefined ? undefined : parseVersion(current);
  if (parsed === undefined) return "0.1.0";
  const { major, minor, patch } = parsed;
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Negative, zero or positive as `left` is older than, the same as or newer than `right`. */
export function compareVersion(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const n = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < n; i++) {
    const cmp = cmpIdent(left.prerelease[i] ?? "", right.prerelease[i] ?? "");
    if (cmp !== 0) return cmp;
  }
  return left.prerelease.length - right.prerelease.length;
}

function cmpIdent(left: string, right: string): number {
  const leftNum = /^\d+$/.test(left);
  const rightNum = /^\d+$/.test(right);
  if (leftNum && rightNum) return Number(left) - Number(right);
  if (leftNum) return -1;
  if (rightNum) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function gte(current: string, min: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(min);
  return left !== undefined && right !== undefined && compareVersion(left, right) >= 0;
}
