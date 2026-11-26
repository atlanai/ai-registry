import { isAbsolute } from "node:path";
import { isRecord, textOf } from "#adapter/fields.ts";
import { type Chunk, isTime, type Load, type ReaderState } from "#core/usage/model.ts";

/** Claude Code's note at the top of a skill it has loaded; the rest of the line is the folder. */
const LOADED = "Base directory for this skill: ";

/**
 * Reads complete lines of a Claude Code transcript. A skill load is a meta user message that
 * opens with {@link LOADED}: the model asked for it when the message answers a tool call, and a
 * person did when they typed its command. Each turn has a `promptId`.
 */
export function readClaudeTranscript(lines: readonly string[], state: ReaderState): Chunk {
  const loads: Load[] = [];
  for (const line of lines) {
    const load = loadOf(line);
    if (load !== undefined) loads.push(load);
  }
  return { loads, state };
}

function loadOf(line: string): Load | undefined {
  // Most lines are conversation; skip them before parsing.
  if (!line.includes(LOADED)) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || record.type !== "user" || record.isMeta !== true) return undefined;
  const path = folderOf(record.message);
  const session = textOf(record.sessionId);
  const at = textOf(record.timestamp);
  if (path === undefined || session === undefined || !isTime(at)) return undefined;
  return {
    session,
    turn: textOf(record.promptId) ?? textOf(record.uuid) ?? at,
    at,
    cwd: textOf(record.cwd),
    path,
    trigger: textOf(record.sourceToolUseID) === undefined ? "person" : "model",
  };
}

function folderOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  const first = Array.isArray(content) ? content[0] : content;
  const text = typeof first === "string" ? first : textOf(isRecord(first) ? first.text : undefined);
  if (text === undefined || !text.startsWith(LOADED)) return undefined;
  const path = text.slice(LOADED.length).split("\n", 1)[0]?.trim();
  return path === undefined || !isAbsolute(path) ? undefined : path;
}
