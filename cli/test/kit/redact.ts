import { readFileSync, realpathSync } from "node:fs";
import type { SnapshotSerializer } from "vitest";

/** The folders a test made, each replaced by its placeholder wherever output names it. */
export interface Places {
  home?: string;
  project?: string;
  root?: string;
}

/** The built CLI's version: the dist is stamped from package.json, not from src. */
const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const literal = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SHA256 = /\b[0-9a-f]{64}\b/g;
const TIME =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|\b\d+(?:ms|s|m|h|d) ago\b/g;
// Bounded so a registry's own `1.0.0` stays, and only the CLI's version is named.
const VERSION_PATTERN = new RegExp(`(?<![\\w.-])${literal(VERSION)}(?![\\w.-])`, "g");

/**
 * A path as written and as resolved: macOS reports `/var/...` as `/private/var/...`. A
 * Windows path also appears JSON-escaped, with each backslash doubled.
 */
function spellings(path: string): string[] {
  let real = path;
  try {
    real = realpathSync.native(path);
  } catch {
    // Not there (yet): only the spelling given can appear.
  }
  const plain = [path, real, real.replace(/^\/private\//, "/")];
  return [...new Set([...plain, ...plain.map((each) => each.replaceAll("\\", "\\\\"))])];
}

/** On Windows, what follows a placeholder reads as the POSIX path a scenario was written with. */
const PLACED = /\[(?:PROJECT|HOME|ROOT)\][^\s"'`]*/g;

/** Placeholders for everything that differs between runs; idempotent. */
export function redact(text: string, places: Places = {}): string {
  const named = (
    [
      ["[PROJECT]", places.project],
      ["[HOME]", places.home],
      ["[ROOT]", places.root],
    ] as const
  ).flatMap(([label, path]) =>
    path === undefined ? [] : spellings(path).map((spelling) => [label, spelling] as const),
  );
  // Longest first, so a project inside the root is named for itself.
  named.sort(([, a], [, b]) => b.length - a.length);
  let out = text;
  for (const [label, spelling] of named) out = out.replaceAll(spelling, label);
  if (process.platform === "win32") {
    out = out.replaceAll(PLACED, (path) => path.replaceAll(/\\{1,2}/g, "/"));
  }
  return out
    .replaceAll(SHA256, "[SHA256]")
    .replaceAll(TIME, "[TIME]")
    .replaceAll(VERSION_PATTERN, "[VERSION]");
}

let current: Places = {};

/** The places the snapshot serializer redacts, until the next test sets its own. */
export function redactPlaces(places: Places): void {
  current = places;
}

/** Redacts every string a snapshot holds against the current test's places. */
export const serializer: SnapshotSerializer = {
  test: (value) => typeof value === "string" && redact(value, current) !== value,
  serialize: (value, config, indentation, depth, refs, printer) =>
    printer(redact(value as string, current), config, indentation, depth, refs),
};
