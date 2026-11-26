import { describe, expect, test } from "vitest";
import { readClaudeTranscript } from "./claude-code.ts";

const SESSION = "5f0c2a7e-0000-4000-8000-000000000001";

function loaded(folder: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    promptId: "turn-1",
    uuid: "u-1",
    sessionId: SESSION,
    timestamp: "2026-11-24T09:15:42.000Z",
    cwd: "/work/app",
    message: {
      role: "user",
      content: [
        { type: "text", text: `Base directory for this skill: ${folder}\n\nThe skill's body.` },
      ],
    },
    ...extra,
  });
}

describe("readClaudeTranscript", () => {
  test("reads a skill the model loaded through a tool call", () => {
    const { loads } = readClaudeTranscript(
      [loaded("/home/dev/.claude/skills/pr-review", { sourceToolUseID: "toolu_1" })],
      {},
    );
    expect(loads).toEqual([
      {
        session: SESSION,
        turn: "turn-1",
        at: "2026-11-24T09:15:42.000Z",
        cwd: "/work/app",
        path: "/home/dev/.claude/skills/pr-review",
        trigger: "model",
      },
    ]);
  });

  test("reads a skill a person started by typing its command", () => {
    const { loads } = readClaudeTranscript([loaded("/home/dev/.claude/skills/pr-review")], {});
    expect(loads.map((load) => load.trigger)).toEqual(["person"]);
  });

  test("keeps nothing of the conversation", () => {
    const { loads } = readClaudeTranscript([loaded("/home/dev/.claude/skills/pr-review")], {});
    expect(JSON.stringify(loads)).not.toContain("The skill's body");
  });

  test("skips conversation, other meta messages, broken lines and relative paths", () => {
    const { loads } = readClaudeTranscript(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: "Base directory for this skill: /x" },
        }),
        JSON.stringify({ type: "user", message: { content: "Base directory for this skill: /x" } }),
        `{"type":"user","isMeta":true,"message":"Base directory for this skill: /x"`,
        loaded("skills/pr-review"),
      ],
      {},
    );
    expect(loads).toEqual([]);
  });
});
