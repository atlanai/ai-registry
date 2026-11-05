import type { ArtifactKind } from "#adapter/index.ts";
import { isSafePath } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { isRecord, textOf } from "#core/fields.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "#core/kinds.ts";
import { ManifestError } from "./errors.ts";

/** One file an export publishes, from its path in the artifact to the path it is stored at. */
export interface ExportFile {
  from: string;
  as: string;
}

const GLOB = /[*?[\]{}]/;

export function isGlob(path: string): boolean {
  return GLOB.test(path);
}

/** Why a path cannot name something below the project, or undefined when it can. */
export function pathProblem(path: string): string | undefined {
  if (path.includes("\\")) return "uses a backslash, where a path uses /";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "is absolute";
  const parts = path.split("/");
  // A glob's brace alternatives are path parts too: `{..,skills}/*` climbs out as `../*` does.
  if (parts.includes("..") || /(?:^|[/{,])\.\.(?=$|[/,}])/.test(path)) return "leaves the project";
  if (parts.some((part) => part === "" || part === ".")) return "has an empty or . part";
  return undefined;
}

export const PATH_HINT = "Write it relative to the project, such as .claude/skills/review.";

const EXPORT_KINDS: readonly ArtifactKind[] = ["skill", "agent"];

export function exportKind(raw: unknown, path: string): ArtifactKind | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && (EXPORT_KINDS as readonly string[]).includes(raw)) {
    return raw as ArtifactKind;
  }
  throw new ManifestError(`\`kind\` of export ${quoted(path)} must be skill or agent.`);
}

/** Names of folders or files directly inside the entry's folder, which it then does not reach. */
export function exportExclude(raw: unknown, path: string): string[] | undefined {
  const names = texts(raw, "exclude", path, "names");
  for (const name of names ?? []) {
    if (
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".." ||
      isGlob(name)
    ) {
      throw new ManifestError(
        `Export ${quoted(path)} excludes ${quoted(name)}, which is not the name of something directly inside it.`,
        "Write the name alone, such as drafts, with no / or glob.",
      );
    }
  }
  return names;
}

function texts(raw: unknown, key: string, path: string, what: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => textOf(item) === undefined)) {
    throw new ManifestError(`\`${key}\` of export ${quoted(path)} must be a list of ${what}.`);
  }
  const seen = new Set<string>();
  for (const item of raw as string[]) {
    if (seen.has(item)) {
      throw new ManifestError(
        `Export ${quoted(path)} lists ${quoted(item)} twice under \`${key}\`.`,
      );
    }
    seen.add(item);
  }
  return raw as string[];
}

/** Gitignore patterns, read against each artifact the entry reaches. */
export function exportIgnore(raw: unknown, path: string): string[] | undefined {
  return texts(raw, "ignore", path, "gitignore patterns");
}

const ENTRIES: ReadonlySet<string> = new Set([SKILL_ENTRY, AGENT_ENTRY]);

/** Validate include mappings without moving entry files or assigning two files to one destination. */
export function exportInclude(raw: unknown, path: string): ExportFile[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ManifestError(
      `\`include\` of export ${quoted(path)} must list paths, or \`{ from, as }\` mappings.`,
    );
  }
  const items = raw.map((item) => includeItem(item, path));
  const stored = new Set<string>();
  const read = new Set<string>();
  for (const { from, as } of items) {
    if (ENTRIES.has(as) && from !== as) {
      throw new ManifestError(
        `Export ${quoted(path)} would store ${from} as ${as}, which is an entry file.`,
        "An artifact's entry file is always published as itself; store the file at another path.",
      );
    }
    if (ENTRIES.has(from) && from !== as) {
      throw new ManifestError(
        `Export ${quoted(path)} would store its entry file ${from} as ${as}.`,
        "An artifact's entry file is always published as itself; leave it out of `include`.",
      );
    }
    if (read.has(from)) {
      throw new ManifestError(`Export ${quoted(path)} lists ${from} twice under \`include\`.`);
    }
    if (stored.has(as)) {
      throw new ManifestError(`Export ${quoted(path)} would store two files as ${as}.`);
    }
    stored.add(as);
    read.add(from);
  }
  return items;
}

function includeItem(raw: unknown, path: string): ExportFile {
  if (typeof raw === "string" && raw.trim() !== "") {
    const from = insidePath(raw, path, "include");
    return { from, as: from };
  }
  if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "from" && key !== "as")) {
    throw new ManifestError(
      `\`include\` of export ${quoted(path)} must list paths, or \`{ from, as }\` mappings.`,
    );
  }
  const [from, as] = [textOf(raw.from), textOf(raw.as)];
  if (from === undefined || as === undefined) {
    throw new ManifestError(
      `An \`include\` mapping of export ${quoted(path)} needs both \`from\` and \`as\`.`,
    );
  }
  return { from: insidePath(from, path, "from"), as: insidePath(as, path, "as") };
}

function insidePath(text: string, path: string, key: "from" | "as" | "include"): string {
  const problem =
    pathProblem(text) ?? (isSafePath(text) ? undefined : "is no path a registry stores");
  const shown = `\`${key === "include" ? "include" : `include ${key}`}\` ${quoted(text)} of export ${quoted(path)}`;
  if (problem !== undefined) {
    throw new ManifestError(
      `${shown} ${problem.replace("the project", "the artifact")}.`,
      "Write it relative to the artifact's folder, such as workspace/AGENTS.md.",
    );
  }
  if (isGlob(text)) {
    throw new ManifestError(
      `${shown} is a glob, not a file or folder.`,
      "Name each file or folder to publish.",
    );
  }
  return text;
}
