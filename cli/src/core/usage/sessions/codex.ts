import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord, textOf } from "#adapter/fields.ts";
import { type Chunk, isTime, type Load, type ReaderState } from "#core/usage/model.ts";

/** A skill's entry file, named in a command the agent ran: an absolute or a relative path. */
const ENTRY = /(?:^|[\s'"`=(:])((?:~|\.{1,2})?[^\s'"`;|&<>()=:]*\/SKILL\.md)(?=$|[\s'"`;|&<>)])/g;

/** A command that prints a file, as the agent does to read a skill. */
const READS = /\b(cat|head|tail|less|more|bat|nl|sed\s+-n|awk)\b/;
/** A command that changes a file or only lists it, which is no run. */
const CHANGES =
  /\b(sed\s+-i|tee|rm|mv|cp|touch|chmod|ls|find|grep|rg|git)\b|>>?\s*\S*SKILL\.md|\*\*\* (Begin|Update|Add|Delete) File/;

/** Only a command that reads, and changes nothing, uses a skill; an edit or a listing does not. */
function reads(command: string): boolean {
  return READS.test(command) && !CHANGES.test(command);
}

/**
 * Reads complete lines of a Codex rollout. Codex lists its skills to the model, which reads a
 * skill by running a command on its `SKILL.md`, so each such command is a load the model started.
 * The session, its folder and the turn come from earlier records, carried in `state`.
 */
export function readCodexRollout(lines: readonly string[], state: ReaderState): Chunk {
  const loads: Load[] = [];
  let current: Record<string, string> = { ...state };
  for (const line of lines) {
    const record = parse(line);
    if (record === undefined) continue;
    current = { ...current, ...contextOf(record) };
    loads.push(...loadsOf(record, current));
  }
  return { loads, state: current };
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const record: unknown = JSON.parse(line);
    return isRecord(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

/** The session, its folder and the turn, as `session_meta`, `turn_context` and `task_started` say. */
function contextOf(record: Record<string, unknown>): Record<string, string> {
  const payload = isRecord(record.payload) ? record.payload : {};
  const found: Record<string, string> = {};
  if (record.type === "session_meta") {
    const session = textOf(payload.id) ?? textOf(payload.session_id);
    if (session !== undefined) found.session = session;
  }
  const cwd = textOf(payload.cwd);
  if (cwd !== undefined && (record.type === "session_meta" || record.type === "turn_context")) {
    found.cwd = cwd;
  }
  const turn = record.type === "turn_context" ? textOf(payload.turn_id) : startedTurn(payload);
  if (turn !== undefined) found.turn = turn;
  return found;
}

/** The turn a `task_started` event opens. */
function startedTurn(payload: Record<string, unknown>): string | undefined {
  if (payload.type !== "task_started" || !isRecord(payload.turn_attribution)) return undefined;
  return textOf(payload.turn_attribution.turn_id);
}

function loadsOf(record: Record<string, unknown>, context: Record<string, string>): Load[] {
  if (record.type !== "response_item" || !isRecord(record.payload)) return [];
  const { session, turn, cwd } = context;
  const at = textOf(record.timestamp);
  if (session === undefined || turn === undefined || !isTime(at)) return [];
  const command = commandOf(record.payload);
  if (command === undefined || !reads(command.text)) return [];
  const base = command.workdir ?? cwd;
  const folders = new Set<string>();
  for (const match of command.text.matchAll(ENTRY)) {
    const named = match[1];
    if (named === undefined) continue;
    const path = absolute(named, base);
    if (path !== undefined) folders.add(dirname(path));
  }
  return [...folders].map((path) => ({ session, turn, at, cwd, path, trigger: "model" as const }));
}

function absolute(named: string, base: string | undefined): string | undefined {
  if (named.startsWith("~/")) return join(homedir(), named.slice(2));
  if (isAbsolute(named)) return named;
  return base === undefined ? undefined : resolve(base, named);
}

/** The text of a command the agent ran, and the folder it ran in when the call names one. */
function commandOf(
  payload: Record<string, unknown>,
): { text: string; workdir: string | undefined } | undefined {
  if (payload.type === "function_call") {
    const raw = textOf(payload.arguments);
    if (raw === undefined) return undefined;
    const args = parse(raw);
    const cmd = args?.cmd ?? args?.command;
    const text = Array.isArray(cmd)
      ? cmd.filter((part) => typeof part === "string").join(" ")
      : textOf(cmd);
    return text === undefined ? undefined : { text, workdir: textOf(args?.workdir) };
  }
  // A patch edits the file it names; it never reads one.
  if (payload.type === "custom_tool_call" && payload.name !== "apply_patch") {
    const text = textOf(payload.input);
    return text === undefined ? undefined : { text, workdir: undefined };
  }
  return undefined;
}
