import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { list } from "#adapter/text.ts";
import { frontmatterRecord } from "#core/frontmatter.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import type { Action } from "#core/plan/model.ts";
import type { KeyFile } from "#core/target/contract.ts";

type KeyNeeds = { files: KeyFile[] } | { refused: string };

/** A key written false or left empty sets nothing. */
const sets = (value: unknown) => value !== undefined && value !== null && value !== false;

/** The files the keys it sets need, or why it is left out rather than installed without one. */
export async function keyNeeds(
  action: Extract<Action, { kind: "link" }>,
  written: string | undefined,
): Promise<KeyNeeds> {
  if (action.keys === undefined) return { files: [] };
  const text =
    written ??
    (await readFile(join(action.from, action.entry ?? SKILL_ENTRY), "utf8").catch(() => undefined));
  const record = text === undefined ? undefined : frontmatterRecord(text);
  const files: KeyFile[] = [];
  for (const [key, rule] of Object.entries(action.keys)) {
    if (!sets(record?.[key])) continue;
    if (rule.refusedBy.length > 0) {
      return { refused: `it sets ${key}, which ${list(rule.refusedBy)} cannot read` };
    }
    files.push(...rule.files);
  }
  return { files };
}

export async function writeKeyFiles(folder: string, files: readonly KeyFile[]): Promise<void> {
  for (const file of files) {
    const path = join(folder, file.path);
    const text = file.path.endsWith(".json")
      ? `${JSON.stringify(file.body, null, 2)}\n`
      : stringify(file.body);
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, text);
  }
}
