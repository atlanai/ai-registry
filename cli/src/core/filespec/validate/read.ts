import { isRecord } from "#adapter/fields.ts";
import { readJson, SpecError } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";

export interface Problem {
  /** Root-relative, POSIX: the file or folder to look at. */
  path: string;
  message: string;
  /** The command, or the edit, that fixes it. */
  fix?: string | undefined;
}

export async function text(root: string, path: string): Promise<string | undefined> {
  try {
    const bytes = await rootReader(root)(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** A document that is there but does not parse, as opposed to one refused or missing. */
export function unparsed(error: unknown): boolean {
  return error instanceof SpecError && error.cause instanceof SyntaxError;
}

export async function jsonAt(root: string, path: string, problems: Problem[]): Promise<unknown> {
  try {
    return await readJson(rootReader(root), path);
  } catch (error) {
    if (unparsed(error)) problems.push({ path, message: "is not valid JSON" });
    return undefined;
  }
}

export function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Each listed version and its digest, parsed rather than matched, so any formatting reads alike. */
export function rowsOf(document: unknown): Map<string, unknown> {
  const rows = isRecord(document) && Array.isArray(document.versions) ? document.versions : [];
  return new Map(
    rows.flatMap((row) =>
      isRecord(row) && typeof row.version === "string" ? [[row.version, row.digest] as const] : [],
    ),
  );
}

export async function readDocument(
  root: string,
  at: string,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readJson(rootReader(root), at).catch(() => undefined);
  return isRecord(raw) ? raw : undefined;
}
