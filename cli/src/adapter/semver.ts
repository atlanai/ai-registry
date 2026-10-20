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

function cmpIdent(left: string, right: string): number {
  const leftNum = /^\d+$/.test(left);
  const rightNum = /^\d+$/.test(right);
  if (leftNum && rightNum) return Number(left) - Number(right);
  if (leftNum) return -1;
  if (rightNum) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
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

export function gte(current: string, min: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(min);
  return left !== undefined && right !== undefined && compareVersion(left, right) >= 0;
}

/** The longest range the file spec reads (section 2.4). */
export const MAX_RANGE = 256;

type Operator = "=" | ">" | ">=" | "<" | "<=";

/** One bound a version is held to, once `^`, `~` and partial versions are read as the bounds they mean. */
interface Comparator {
  operator: Operator;
  version: Version;
}

/**
 * A version range as the file spec defines it (section 2.4): a version satisfies it when it
 * meets every comparator of any one set.
 */
export interface Range {
  readonly sets: readonly (readonly Comparator[])[];
}

const PART = new RegExp(`^(?:${NUMBER}|[xX*])$`);
const WILDCARD = /^[xX*]$/;
const OPERATOR = /^(?:<=|>=|<|>|=|\^|~)/;

/** A full version with nothing around it, since a comparator has no space inside. */
function full(text: string): Version | undefined {
  return /\s/.test(text) ? undefined : parseVersion(text);
}

/** The release a partial version's numbers give, zero-filled; with `at`, that number incremented. */
function release(numbers: readonly number[], at?: number): Version {
  const given = at === undefined ? numbers : [...numbers.slice(0, at), (numbers[at] ?? 0) + 1];
  const [major = 0, minor = 0, patch = 0] = given;
  return { major, minor, patch, prerelease: [] };
}

/** The numbers a partial version gives, in order, or undefined when it is not one. */
function partial(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length > 3 || !parts.every((part) => PART.test(part))) return undefined;
  const given = parts.findIndex((part) => WILDCARD.test(part));
  const numbers = given === -1 ? parts : parts.slice(0, given);
  // A number after a wildcard says nothing a reader could honor.
  if (parts.slice(numbers.length).some((part) => !WILDCARD.test(part))) return undefined;
  const values = numbers.map(Number);
  return values.every((value) => Number.isSafeInteger(value)) ? values : undefined;
}

/** One comparator as the bounds it means, or undefined when it is outside the grammar. */
function comparators(token: string): Comparator[] | undefined {
  const operator = OPERATOR.exec(token)?.[0];
  const body = token.slice(operator?.length ?? 0);
  const exact = full(body);
  if (operator !== undefined && operator !== "^" && operator !== "~") {
    return exact === undefined ? undefined : [{ operator: operator as Operator, version: exact }];
  }
  const numbers = exact === undefined ? partial(body) : [exact.major, exact.minor, exact.patch];
  if (numbers === undefined) return undefined;
  const lower = exact ?? release(numbers);
  if (operator === undefined) {
    if (exact !== undefined) return [{ operator: "=", version: exact }];
    if (numbers.length === 0) return [];
    const upper = release(numbers, numbers.length - 1);
    return [
      { operator: ">=", version: lower },
      { operator: "<", version: upper },
    ];
  }
  // `^` and `~` need the major number at least.
  if (numbers.length === 0) return undefined;
  const nonZero = numbers.findIndex((value) => value !== 0);
  const at =
    operator === "^"
      ? nonZero === -1
        ? numbers.length - 1
        : nonZero
      : Math.min(numbers.length - 1, 1);
  return [
    { operator: ">=", version: lower },
    { operator: "<", version: release(numbers, at) },
  ];
}

/** A range as the file spec writes it (section 2.4); undefined for anything outside that grammar. */
export function parseRange(text: string): Range | undefined {
  if (typeof text !== "string" || text.length > MAX_RANGE) return undefined;
  const sets: Comparator[][] = [];
  for (const alternative of text.split("||")) {
    const tokens = alternative.split(" ").filter((token) => token !== "");
    if (tokens.length === 0) return undefined;
    const set: Comparator[] = [];
    for (const token of tokens) {
      const meant = comparators(token);
      if (meant === undefined) return undefined;
      set.push(...meant);
    }
    sets.push(set);
  }
  return { sets };
}

function holds({ operator, version }: Comparator, candidate: Version): boolean {
  const cmp = compareVersion(candidate, version);
  if (operator === "=") return cmp === 0;
  if (operator === ">") return cmp > 0;
  if (operator === ">=") return cmp >= 0;
  if (operator === "<") return cmp < 0;
  return cmp <= 0;
}

/** Same major, minor and patch, which is what lets a comparator admit a prerelease. */
function sameRelease(left: Version, right: Version): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function inSet(set: readonly Comparator[], candidate: Version): boolean {
  if (!set.every((comparator) => holds(comparator, candidate))) return false;
  // A prerelease satisfies a set only when the set names a prerelease of that release.
  return (
    candidate.prerelease.length === 0 ||
    set.some(({ version }) => version.prerelease.length > 0 && sameRelease(version, candidate))
  );
}

/** Whether a version satisfies a range; a version that is not SemVer, or a range that does not parse, satisfies nothing. */
export function satisfies(version: string, range: Range | string): boolean {
  const parsed = typeof range === "string" ? parseRange(range) : range;
  const candidate = full(version);
  if (parsed === undefined || candidate === undefined) return false;
  return parsed.sets.some((set) => inSet(set, candidate));
}

/** The highest of `versions` that satisfies the range, as written there. */
export function maxSatisfying(
  versions: readonly string[],
  range: Range | string,
): string | undefined {
  const parsed = typeof range === "string" ? parseRange(range) : range;
  if (parsed === undefined) return undefined;
  let best: { text: string; version: Version } | undefined;
  for (const text of versions) {
    if (!satisfies(text, parsed)) continue;
    const version = full(text) as Version;
    if (best === undefined || compareVersion(version, best.version) > 0) best = { text, version };
  }
  return best?.text;
}

/** The stricter of two bounds on one side: further in, by `inward`, or as far and exclusive. */
function stricter(held: Comparator | undefined, bound: Comparator, inward: 1 | -1): Comparator {
  if (held === undefined) return bound;
  const cmp = compareVersion(bound.version, held.version) * inward;
  if (cmp > 0) return bound;
  return cmp === 0 && (bound.operator === ">" || bound.operator === "<") ? bound : held;
}

/** A set as its tightest bounds, which admit the same versions; undefined when none can satisfy it. */
function tightened(set: readonly Comparator[]): Comparator[] | undefined {
  let lower: Comparator | undefined;
  let upper: Comparator | undefined;
  let exact: Version | undefined;
  for (const comparator of set) {
    const { operator, version } = comparator;
    if (operator === "=") {
      if (exact !== undefined && compareVersion(exact, version) !== 0) return undefined;
      exact = version;
      continue;
    }
    if (operator === ">" || operator === ">=") lower = stricter(lower, comparator, 1);
    else upper = stricter(upper, comparator, -1);
  }
  if (exact !== undefined) {
    const meets = [lower, upper].every((bound) => bound === undefined || holds(bound, exact));
    return meets ? [{ operator: "=", version: exact }] : undefined;
  }
  if (lower !== undefined && upper !== undefined) {
    const cmp = compareVersion(lower.version, upper.version);
    const closed = lower.operator === ">=" && upper.operator === "<=";
    if (cmp > 0 || (cmp === 0 && !closed)) return undefined;
    if (cmp === 0) return [{ operator: "=", version: lower.version }];
  }
  return [lower, upper].filter((bound) => bound !== undefined);
}

/**
 * The versions every one of the ranges admits, as one range, or undefined when no version can
 * satisfy them all. Each set keeps its tightest bounds, so a prerelease the merged set admits may
 * still be refused by one of the ranges on its own; check each before taking a version.
 */
export function intersect(ranges: readonly Range[]): Range | undefined {
  let sets: Comparator[][] = [[]];
  for (const range of ranges) {
    const next = new Map<string, Comparator[]>();
    for (const left of sets) {
      for (const right of range.sets) {
        const merged = tightened([...left, ...right]);
        if (merged !== undefined) next.set(formatSet(merged), merged);
      }
    }
    if (next.size === 0) return undefined;
    sets = [...next.values()];
  }
  return { sets };
}

function formatSet(set: readonly Comparator[]): string {
  if (set.length === 0) return "*";
  return set.map(({ operator, version }) => `${operator}${formatVersion(version)}`).join(" ");
}

/** The range written in the file spec's grammar, so it reads back as the same range. */
export function formatRange(range: Range): string {
  return range.sets.map(formatSet).join(" || ");
}
