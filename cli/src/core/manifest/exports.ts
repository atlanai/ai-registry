import { isRecord, textOf } from "#adapter/fields.ts";
import { formatVersion, parseVersion } from "#adapter/semver.ts";
import { quoted } from "#adapter/text.ts";
import { withoutUndefined } from "#core/fields.ts";
import { formatAddress, formatRef, parseRef, type Ref, RefParseError } from "#core/ref.ts";
import { ManifestError } from "./errors.ts";
import {
  exportExclude,
  exportIgnore,
  exportInclude,
  exportKind,
  isGlob,
  PATH_HINT,
  pathProblem,
} from "./export-fields.ts";
import { onlyKnown, optionalString } from "./field-guards.ts";
import { artifactFor } from "./match.ts";
import { EXPORT_KEYS, type Export, type ExportDependency } from "./model.ts";

export function parseExports(raw: unknown, artifacts: readonly Ref[]): Export[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ManifestError("`exports:` must be a list of paths.");
  const seen = new Set<string>();
  return raw.map((item) => {
    const entry = exportEntry(item, artifacts);
    if (seen.has(entry.path)) {
      throw new ManifestError(`Export ${quoted(entry.path)} is listed more than once.`);
    }
    seen.add(entry.path);
    return entry;
  });
}

function exportEntry(raw: unknown, artifacts: readonly Ref[]): Export {
  if (typeof raw === "string") {
    return { path: exportPath(raw), version: undefined, dependsOn: [], publish: undefined };
  }
  if (!isRecord(raw)) {
    throw new ManifestError("`exports:` entries must be paths or `{ path, ... }` mappings.");
  }
  onlyKnown(raw, EXPORT_KEYS, "An `exports:` entry");
  const text = optionalString(raw, "path");
  if (text === undefined) throw new ManifestError("An `exports:` entry has no `path`.");
  const path = exportPath(text);
  // A glob's members are refined by entries of their own, so one path never reads two ways.
  if (isGlob(path)) {
    throw new ManifestError(
      `Export ${quoted(path)} is a glob, which only a plain \`exports:\` entry can be.`,
      {
        hint: "Give each path it matches an entry of its own to set its version, dependencies or targets.",
      },
    );
  }
  const optional = withoutUndefined({
    kind: exportKind(raw.kind, path),
    exclude: exportExclude(raw.exclude, path),
    ignore: exportIgnore(raw.ignore, path),
    include: exportInclude(raw.include, path),
  });
  return {
    path,
    version: exportVersion(raw.version, path),
    dependsOn: dependencies(raw.depends_on, path, artifacts),
    publish: exportPublish(raw.publish, path),
    ...optional,
  };
}

function exportPath(text: string): string {
  if (text.trim() === "") throw new ManifestError("An `exports:` entry has an empty path.");
  const problem = pathProblem(text);
  if (problem !== undefined) {
    throw new ManifestError(`Export ${quoted(text)} ${problem}.`, { hint: PATH_HINT });
  }
  return text;
}

function dependencies(raw: unknown, path: string, artifacts: readonly Ref[]): ExportDependency[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => textOf(item) === undefined)) {
    throw new ManifestError(
      `\`depends_on\` of export ${quoted(path)} must be a list of paths and addresses.`,
    );
  }
  const seen = new Set<string>();
  return (raw as string[]).map((text) => {
    if (seen.has(text)) {
      throw new ManifestError(
        `Export ${quoted(path)} lists ${quoted(text)} twice under \`depends_on\`.`,
      );
    }
    seen.add(text);
    return dependency(text, path, artifacts);
  });
}

function dependency(text: string, path: string, artifacts: readonly Ref[]): ExportDependency {
  const of = `Export ${quoted(path)} depends on ${quoted(text)}`;
  if (text.startsWith("./")) {
    const local = text.slice(2);
    const problem = pathProblem(local);
    if (problem !== undefined)
      throw new ManifestError(`${of}, whose path ${problem}.`, { hint: PATH_HINT });
    if (isGlob(local)) {
      throw new ManifestError(`${of}, a glob rather than a path.`, {
        hint: "Name an artifact, or a folder of them, such as ./skills.",
      });
    }
    if (local === path) throw new ManifestError(`Export ${quoted(path)} depends on itself.`);
    return { type: "local", path: local };
  }
  let ref: Ref | undefined;
  try {
    ref = parseRef(text);
  } catch (error) {
    if (!(error instanceof RefParseError)) throw error;
  }
  if (ref === undefined || ref.namespace === undefined || ref.kind === undefined) {
    throw new ManifestError(
      `${of}, which is neither ./<path> nor <registry>/<namespace>/<kind>/<name>.`,
      { hint: "Start a path in this project with ./, such as ./.claude/skills/review." },
    );
  }
  const address = formatAddress(ref);
  // Which versions it takes is the install's to say, so it is said once.
  if (ref.version !== undefined) {
    throw new ManifestError(`${of}, but its version belongs on its \`artifacts:\` entry.`, {
      hint: `Write ${address} here, and ${formatRef(ref)} under \`artifacts:\`.`,
    });
  }
  if (artifactFor(artifacts, ref) === undefined) {
    // The hint is not `aireg add`, which reads this manifest first and so stops here too.
    throw new ManifestError(`${of}, which is not listed under \`artifacts:\`.`, {
      hint: `List it under \`artifacts:\`, such as \`- ${address}\`.`,
    });
  }
  return { type: "remote", ref };
}

function exportVersion(raw: unknown, path: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === "string" ? parseVersion(raw) : undefined;

  if (parsed === undefined || formatVersion(parsed) !== raw) {
    throw new ManifestError(
      `\`version\` of export ${quoted(path)} must be an exact version, such as 2.0.0.`,
    );
  }
  return raw;
}

function exportPublish(raw: unknown, path: string): false | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === false) return false;
  // One target for the whole project, so an entry can only keep itself out of it.
  throw new ManifestError(`\`publish\` of export ${quoted(path)} takes only false.`, {
    hint: "Remove it to publish the export to `publish.to`, or write `publish: false` to keep it here.",
  });
}
