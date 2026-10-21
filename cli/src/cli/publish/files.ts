import { resolve } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { gitignore } from "#core/fs/gitignore.ts";
import { posixRelative } from "#core/fs/path.ts";
import { authored } from "#core/fs/tree.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "#core/kinds.ts";
import type { Export, ExportFile } from "#core/manifest.ts";

// Which files one folder artifact publishes, and the path each is stored at: in a git repository
// only what git tracks, never what belongs to an artifact inside it that is exported on its own,
// only what `include` lists when an entry has it, less what `ignore` leaves out, and always its
// entry file, as itself.

/** The file that makes a folder the kind it is, published first and always as itself. */
function entryOf(kind: ArtifactKind): string {
  return kind === "agent" ? AGENT_ENTRY : SKILL_ENTRY;
}

/** What one folder artifact's files are chosen against. */
export interface Choosing {
  root: string;
  kind: ArtifactKind;
  /** Every entry reaching it, so each `include` and `ignore` applies. */
  entries: readonly Export[];
  /** Files git tracks below the project, or undefined outside a repository. */
  tracked: readonly string[] | undefined;
  /** Every artifact that is exported, so one inside this one publishes its own files. */
  exported: Iterable<string>;
  /** The patterns of each entry that left something out, keyed by entry path and pattern. */
  matched: Set<string>;
}

/** Below the folder, by its path relative to it: what git tracks, or every file in it. */
async function candidates(root: string, tracked: readonly string[] | undefined): Promise<string[]> {
  if (tracked !== undefined) {
    return tracked
      .filter((file) => file !== root && isWithin(root, file))
      .map((file) => posixRelative(root, file));
  }
  // A link or a file that may hold credentials stays listed, so the publish refuses it by name.
  const { files, irregular } = await authored(root);
  return [...files, ...irregular].map((file) => file.path).sort();
}

/** The files `include` lists, each at the path it is stored at; a path that matches nothing is refused. */
function included(
  held: readonly string[],
  include: readonly { entry: Export; file: ExportFile }[],
  shown: string,
  tracked: boolean,
): ExportFile[] {
  const out: ExportFile[] = [];
  for (const { entry, file } of include) {
    const inside = held.filter((path) => path.startsWith(`${file.from}/`));
    if (held.includes(file.from)) out.push(file);
    else if (inside.length > 0) {
      for (const path of inside)
        out.push({ from: path, as: `${file.as}${path.slice(file.from.length)}` });
    } else {
      throw new AiregError(
        `Export ${quoted(entry.path)} includes ${file.from}, which ${shown} does not hold.`,
        {
          code: ErrorCode.NotFound,
          hint: tracked
            ? "Check the path under `include`, relative to the artifact's folder, and that git tracks it."
            : "Check the path under `include`, relative to the artifact's folder.",
        },
      );
    }
  }
  return out;
}

/** Two files stored at one path would overwrite each other, so they are refused. */
function refuseShared(files: readonly ExportFile[], shown: string): void {
  const by = new Map<string, string>();
  for (const { from, as } of files) {
    const other = by.get(as);
    if (other !== undefined && other !== from) {
      throw new AiregError(`${shown} would publish both ${other} and ${from} as ${as}.`, {
        code: ErrorCode.Invalid,
        hint: "Store one of them at another path with `include`'s `as`.",
      });
    }
    by.set(as, from);
  }
}

/**
 * What a folder artifact publishes, relative to it, each with the path it is stored at, its entry
 * file first: the entries' `include` lists combined, or every file, less what their `ignore`
 * patterns leave out.
 */
export async function chooseFiles(choosing: Choosing, base: string): Promise<ExportFile[]> {
  const { root, kind, entries, tracked } = choosing;
  const shown = posixRelative(base, root);
  const entry = entryOf(kind);
  // An artifact inside this one that is exported is published on its own, so it is not part of this one.
  const nested = [...choosing.exported].filter((other) => other !== root && isWithin(root, other));
  const held = (await candidates(root, tracked)).filter(
    (path) => !nested.some((other) => isWithin(other, resolve(root, path))),
  );
  const include = entries.flatMap((each) =>
    (each.include ?? []).map((file) => ({ entry: each, file })),
  );
  const listed = entries.some((each) => each.include !== undefined);
  const chosen = listed
    ? included(held, include, shown, tracked !== undefined)
    : held.map((path) => ({ from: path, as: path }));
  const patterns = entries.flatMap((each) =>
    (each.ignore ?? []).map((pattern) => ({ entry: each, pattern })),
  );
  const ignore = gitignore(patterns.map((each) => each.pattern));
  const kept = chosen.filter((file) => file.from === entry || !ignore.ignores(file.from));
  const unmatched = new Set(ignore.unmatched());
  for (const { entry: each, pattern } of patterns) {
    if (!unmatched.has(pattern)) choosing.matched.add(`${each.path}\0${pattern}`);
  }
  const files = [{ from: entry, as: entry }, ...kept.filter((file) => file.from !== entry)];
  refuseShared(files, shown);
  // One file listed by two entries is one file.
  const unique = [...new Map(files.map((file) => [`${file.from}\0${file.as}`, file])).values()];
  const [first, ...rest] = unique;
  return [first as ExportFile, ...rest.sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : 0))];
}
