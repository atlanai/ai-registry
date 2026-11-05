import { resolve } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { gitignore } from "#core/fs/gitignore.ts";
import { posixRelative } from "#core/fs/path.ts";
import { authored } from "#core/fs/tree.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "#core/kinds.ts";
import type { ExportFile } from "#core/manifest/export-fields.ts";
import type { Export } from "#core/manifest/model.ts";

/** The files to publish after `include` and `ignore`: the entry first, the rest sorted by stored path. */
export async function chooseFiles(choosing: Choosing, base: string): Promise<ExportFile[]> {
  const { root, kind, entries, tracked } = choosing;
  const shown = posixRelative(base, root);
  const entry = entryOf(kind);

  const nested = [...choosing.exported].filter((other) => other !== root && isWithin(root, other));
  const all = await candidates(root, tracked);
  const held = all.filter((path) => !nested.some((other) => isWithin(other, resolve(root, path))));
  const include = entries.flatMap((each) =>
    (each.include ?? []).map((file) => ({ entry: each, file })),
  );
  const listed = entries.some((each) => each.include !== undefined);
  const chosen = listed
    ? included({ own: held, all }, include, { shown, tracked: tracked !== undefined })
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

  const unique = [...new Map(files.map((file) => [`${file.from}\0${file.as}`, file])).values()];
  const [first, ...rest] = unique;
  return [first as ExportFile, ...rest.sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : 0))];
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
  /** Filled with each entry's patterns that left something out, keyed by entry path and pattern. */
  matched: Set<string>;
}

function entryOf(kind: ArtifactKind): string {
  return kind === "agent" ? AGENT_ENTRY : SKILL_ENTRY;
}

const matches = (paths: readonly string[], from: string) =>
  paths.some((path) => path === from || path.startsWith(`${from}/`));

async function candidates(root: string, tracked: readonly string[] | undefined): Promise<string[]> {
  if (tracked !== undefined) {
    return tracked
      .filter((file) => file !== root && isWithin(root, file))
      .map((file) => posixRelative(root, file));
  }

  const { files, irregular } = await authored(root);
  return [...files, ...irregular].map((file) => file.path).sort();
}

function included(
  held: { own: readonly string[]; all: readonly string[] },
  include: readonly { entry: Export; file: ExportFile }[],
  how: { shown: string; tracked: boolean },
): ExportFile[] {
  const out: ExportFile[] = [];
  for (const { entry, file } of include) {
    if (!matches(held.own, file.from))
      throw unmatched(entry, file.from, matches(held.all, file.from), how);
    if (held.own.includes(file.from)) out.push(file);
    for (const path of held.own.filter((each) => each.startsWith(`${file.from}/`))) {
      out.push({ from: path, as: `${file.as}${path.slice(file.from.length)}` });
    }
  }
  return out;
}

function unmatched(
  entry: Export,
  from: string,
  inner: boolean,
  how: { shown: string; tracked: boolean },
) {
  if (inner) {
    return new AiregError(
      `Export ${quoted(entry.path)} includes ${from}, which belongs to an artifact inside ${how.shown} that is exported on its own.`,
      {
        code: ErrorCode.Invalid,
        hint: "Remove it from `include`, or the entry that exports the artifact inside.",
      },
    );
  }
  return new AiregError(
    `Export ${quoted(entry.path)} includes ${from}, which ${how.shown} does not hold.`,
    {
      code: ErrorCode.NotFound,
      hint: how.tracked
        ? "Check the path under `include`, relative to the artifact's folder, and that git tracks it."
        : "Check the path under `include`, relative to the artifact's folder.",
    },
  );
}

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
