import { list, plural, quoted, sanitizeName } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { reaches } from "#core/manifest/match.ts";
import { parseRef, type Ref } from "#core/ref.ts";

/** Each installed artifact's shortest name that no other artifact in the scope shares. */
export function shownNames(lock: Lock): Map<string, string> {
  const rows = Object.entries(lock.artifacts);
  const written = rows.map(([key, row]) => forms(key, row));
  const counts = new Map<string, number>();
  for (const names of written) {
    for (const name of new Set(names)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    rows.map(([key], index) => {
      const names = written[index] as string[];
      return [key, names.find((name) => counts.get(name) === 1) ?? key];
    }),
  );
}

/** The ways to write one installed artifact, shortest first; the last is unique in any scope. */
function forms(key: string, row: LockArtifact): string[] {
  const namespace = row.namespace === undefined ? [] : [row.namespace];
  // Installed under a name of its own, that name is the one its target shows.
  const own = !key.includes("/") && key !== row.name ? [key] : [];
  return [
    ...own,
    row.name,
    [...namespace, row.name].join("/"),
    [...namespace, row.kind, row.name].join("/"),
    [row.registry, ...namespace, row.kind, row.name].join("/"),
    key,
  ];
}

/**
 * The installed rows a name or address reaches. `whole` says it named a whole
 * registry or namespace, which means several; a name meaning several is ambiguous.
 */
export function matchInstalled(input: string, lock: Lock): { rows: string[]; whole: boolean } {
  const written = Object.entries(lock.artifacts).filter(
    ([key, row]) => forms(key, row).includes(input) || row.name === sanitizeName(input),
  );
  if (written.length > 0) return { rows: written.map(([key]) => key), whole: false };
  const ref = parsed(input);
  if (ref === undefined) return { rows: [], whole: false };
  const rows = Object.keys(lock.artifacts).filter((key) =>
    reaches(ref, lock.artifacts[key] as LockArtifact),
  );
  return { rows, whole: ref.name === undefined };
}

function parsed(input: string): Ref | undefined {
  try {
    return parseRef(input);
  } catch {
    return undefined;
  }
}

/**
 * Accepts any address `add` does, as well as installed names, so
 * `remove acme/platform/skill/lint` undoes `add acme/platform/skill/lint`.
 */
export function rowsNamed(input: string, lock: Lock): string[] {
  const { rows, whole } = matchInstalled(input, lock);
  if (rows.length === 0) {
    throw new AiregError(`No installed artifact named ${quoted(input)}.`, {
      code: ErrorCode.NotFound,
      hint: "Run `aireg list` to see what is installed.",
    });
  }
  if (rows.length > 1 && !whole) {
    const each = rows
      .map((key) => forms(key, lock.artifacts[key] as LockArtifact)[3] as string)
      .sort();
    throw new AiregError(
      `${quoted(input)} matches ${plural(rows.length, "installed artifact")}: ${list(each)}.`,
      {
        code: ErrorCode.Usage,
        hint: `Name one of them, such as ${each[0]}.`,
      },
    );
  }
  return rows;
}
