import { sanitizeText } from "#adapter/text.ts";
import { engineFromUnknown } from "./engines.ts";
import { isRecord } from "./fields.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "./kinds.ts";
import { parseYaml } from "./yaml.ts";

export interface Frontmatter {
  name: string | undefined;
  description: string | undefined;
  engine: string | undefined;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/;

/** Section 3.4's limit. An envelope keeps the whole description; a reader shortens it to print. */
const DESCRIPTION_LIMIT = 4000;

/** A description as an envelope records it: one line, escapes removed, at most the spec's limit. */
export function descriptionText(text: string): string {
  return sanitizeText(text, DESCRIPTION_LIMIT);
}

/**
 * The front-matter description in an artifact's own Markdown: SKILL.md, AGENT.md, <name>.md,
 * or its only file. A malformed block is ignored, never fatal.
 */
export function ownDescription(
  files: ReadonlyMap<string, Uint8Array>,
  name?: string,
): string | undefined {
  const own =
    files.get(SKILL_ENTRY) ??
    files.get(AGENT_ENTRY) ??
    (name === undefined ? undefined : files.get(`${name}.md`)) ??
    (files.size === 1 && [...files.keys()][0]?.endsWith(".md")
      ? [...files.values()][0]
      : undefined);
  const found =
    own === undefined ? undefined : frontmatter(new TextDecoder().decode(own)).description;
  return found === undefined ? undefined : descriptionText(found);
}

/** Every front-matter field as written; undefined when there is no readable block. */
export function frontmatterRecord(text: string): Record<string, unknown> | undefined {
  const match = FENCE.exec(text);
  if (match === null) return undefined;
  try {
    const doc = parseYaml(match[1] ?? "");
    return isRecord(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** Only the `name:` line changes, so the comments and key order a person wrote survive. */
export function withName(text: string, name: string): string {
  const match = FENCE.exec(text);
  if (match === null) return text;
  return match[0].replace(/^name:.*$/m, `name: ${name}`) + text.slice(match[0].length);
}

/** The front-matter text and what follows it; undefined when there is no block. */
export function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  const match = FENCE.exec(text);
  if (match === null) return undefined;
  return { yaml: match[1] ?? "", body: text.slice(match[0].length) };
}

/** What follows the front matter, or all of the text when it has none. */
export function markdownBody(text: string): string {
  const match = FENCE.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/** The fields aireg reads from front matter; each is undefined when absent or not text. */
export function frontmatter(text: string): Frontmatter {
  const record = frontmatterRecord(text);
  return {
    name: typeof record?.name === "string" ? record.name : undefined,
    description: typeof record?.description === "string" ? record.description : undefined,
    engine: engineFromUnknown(record?.engines),
  };
}
