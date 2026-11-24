import type { SessionFormat } from "#core/target/contract.ts";
import type { Chunk, ReaderState } from "#core/usage/model.ts";
import { readClaudeTranscript } from "./claude-code.ts";
import { readCodexRollout } from "./codex.ts";

type Reader = (lines: readonly string[], state: ReaderState) => Chunk;

const READERS: Readonly<Record<SessionFormat, Reader>> = {
  "claude-code-transcript": readClaudeTranscript,
  "codex-rollout": readCodexRollout,
};

/** Reads complete lines of a session record in the format its target declares. */
export function readSession(
  format: SessionFormat,
  lines: readonly string[],
  state: ReaderState,
): Chunk {
  return READERS[format](lines, state);
}
