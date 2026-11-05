import { isRecord } from "./fields.ts";
import { parseYaml } from "./yaml.ts";

// What a knowledge bundle must be before it is sent: an Open Knowledge Format v0.2 tree, checked
// whole so a pull request preview names every path a registry would refuse rather than the first.

/** A bundle's ceilings, the ones an Open Knowledge Format registry inflates an upload against. */
export const KNOWLEDGE_LIMITS = {
  entries: 10_000,
  totalBytes: 64 * 1024 * 1024,
  pathBytes: 1024,
  depth: 16,
} as const;

/** Section 3's two reserved names: a directory's listing and its change log, at any level. */
const RESERVED = new Set(["index.md", "log.md"]);

/** Root paths a registry serves as downloads of the whole bundle. */
const DOWNLOADS = new Set(["bundle.zip", "bundle.tar.gz"]);

/** One file of a bundle as it is sent, by its path in the bundle. */
export interface KnowledgeFile {
  path: string;
  content: Uint8Array;
}

/** The YAML between a document's opening `---` line and the next line that is exactly `---`. */
function frontmatterBlock(text: string): string | undefined {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(body);
  if (opening === null) return undefined;
  const rest = body.slice(opening[0].length);
  let offset = 0;
  for (const line of rest.split(/(?<=\n)/)) {
    if (line.replace(/\r?\n$/, "") === "---") return rest.slice(0, offset);
    offset += line.length;
  }
  return undefined;
}

/** Why one Markdown document is not a concept, or undefined when it is. */
function conceptProblem(content: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return "is not UTF-8 text (Open Knowledge Format v0.2 §4)";
  }
  const block = frontmatterBlock(text);
  if (block === undefined) {
    return "has no `---` delimited YAML front matter (Open Knowledge Format v0.2 §4.1)";
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return "has front matter that is not YAML (Open Knowledge Format v0.2 §11.1)";
  }
  // An empty block is no mapping problem: it fails below, on its missing `type`.
  const fields = parsed === null || parsed === undefined ? {} : parsed;
  if (!isRecord(fields)) {
    return "has front matter that is not a YAML mapping (Open Knowledge Format v0.2 §11.1)";
  }
  const type = fields.type;
  if (typeof type !== "string" || type.trim() === "") {
    return "has front matter without a non-empty `type` (Open Knowledge Format v0.2 §11.2)";
  }
  return undefined;
}

/** Whether a bundle path is a concept: Markdown, and not one of the reserved names. */
export function isConceptPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return path.endsWith(".md") && !RESERVED.has(name);
}

function pathProblem(path: string): string | undefined {
  const parts = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return "is not a safe path relative to the bundle";
  }
  if (new TextEncoder().encode(path).byteLength > KNOWLEDGE_LIMITS.pathBytes) {
    return `is longer than ${KNOWLEDGE_LIMITS.pathBytes} bytes`;
  }
  if (parts.length > KNOWLEDGE_LIMITS.depth) {
    return `is nested deeper than ${KNOWLEDGE_LIMITS.depth} levels`;
  }
  if (DOWNLOADS.has(path)) return "is reserved for the bundle's own download";
  return undefined;
}

/** Every reason the bundle would be refused, each naming its path; empty when it is a bundle. */
export function knowledgeProblems(files: readonly KnowledgeFile[]): string[] {
  const problems: string[] = [];
  if (files.length === 0) problems.push("holds no files");
  if (files.length > KNOWLEDGE_LIMITS.entries) {
    problems.push(`holds ${files.length} files, more than ${KNOWLEDGE_LIMITS.entries}`);
  }
  const total = files.reduce((sum, file) => sum + file.content.byteLength, 0);
  if (total > KNOWLEDGE_LIMITS.totalBytes) {
    problems.push(`holds ${total} bytes, more than ${KNOWLEDGE_LIMITS.totalBytes}`);
  }
  for (const file of files) {
    const problem =
      pathProblem(file.path) ??
      (isConceptPath(file.path) ? conceptProblem(file.content) : undefined);
    if (problem !== undefined) problems.push(`${file.path} ${problem}`);
  }
  return problems;
}
