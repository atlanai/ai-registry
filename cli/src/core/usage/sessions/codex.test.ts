import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { readCodexRollout } from "./codex.ts";

const META = JSON.stringify({
  timestamp: "2026-11-24T09:00:00.000Z",
  type: "session_meta",
  payload: { id: "019a-session", cwd: "/work/app" },
});
const STARTED = JSON.stringify({
  timestamp: "2026-11-24T09:00:01.000Z",
  type: "event_msg",
  payload: { type: "task_started", turn_attribution: { turn_id: "019a-turn-1" } },
});

function call(cmd: string, workdir?: string): string {
  return JSON.stringify({
    timestamp: "2026-11-24T09:00:05.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd, ...(workdir === undefined ? {} : { workdir }) }),
    },
  });
}

describe("readCodexRollout", () => {
  test("reads each skill the agent opened, in the turn it opened it", () => {
    const { loads } = readCodexRollout(
      [META, STARTED, call("sed -n '1,200p' /home/dev/.agents/skills/pr-review/SKILL.md")],
      {},
    );
    expect(loads).toEqual([
      {
        session: "019a-session",
        turn: "019a-turn-1",
        at: "2026-11-24T09:00:05.000Z",
        cwd: "/work/app",
        path: "/home/dev/.agents/skills/pr-review",
        trigger: "model",
      },
    ]);
  });

  test("resolves a relative path against the command's folder, and ~ against home", () => {
    const { loads } = readCodexRollout(
      [
        META,
        STARTED,
        call("cat .agents/skills/a/SKILL.md && cat ~/.agents/skills/b/SKILL.md", "/work/app"),
      ],
      {},
    );
    expect(loads.map((load) => load.path)).toEqual([
      resolve("/work/app", ".agents/skills/a"),
      join(homedir(), ".agents/skills/b"),
    ]);
  });

  test("reads a skill opened from code the agent ran", () => {
    const code = JSON.stringify({
      timestamp: "2026-11-24T09:00:06.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: 'text(await tools.exec_command({cmd:"cat /home/dev/.agents/skills/c/SKILL.md"}));',
      },
    });
    const { loads } = readCodexRollout([META, STARTED, code], {});
    expect(loads.map((load) => load.path)).toEqual(["/home/dev/.agents/skills/c"]);
  });

  test("carries the session and turn into the next chunk of the file", () => {
    const first = readCodexRollout([META, STARTED], {});
    const { loads } = readCodexRollout([call("cat /s/d/SKILL.md")], first.state);
    expect(loads.map((load) => [load.session, load.turn])).toEqual([
      ["019a-session", "019a-turn-1"],
    ]);
  });

  test("reads nothing before it knows the session and turn", () => {
    expect(readCodexRollout([call("cat /s/d/SKILL.md")], {}).loads).toEqual([]);
  });
});

describe("readCodexRollout, what is no run", () => {
  test("skips a command that edits or lists a skill, and a patch to one", () => {
    const patch = JSON.stringify({
      timestamp: "2026-11-24T09:00:07.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: /home/dev/.agents/skills/a/SKILL.md\n",
      },
    });
    const { loads } = readCodexRollout(
      [
        META,
        STARTED,
        call("sed -i 's/a/b/' /home/dev/.agents/skills/a/SKILL.md"),
        call("ls /home/dev/.agents/skills/*/SKILL.md"),
        call("echo hi > /home/dev/.agents/skills/a/SKILL.md"),
        patch,
        call("cat /home/dev/.agents/skills/b/SKILL.md 2>/dev/null"),
      ],
      {},
    );
    expect(loads.map((load) => load.path)).toEqual(["/home/dev/.agents/skills/b"]);
  });

  test("skips a record whose time will not read", () => {
    const bad = JSON.stringify({
      timestamp: "yesterday",
      type: "response_item",
      payload: { type: "function_call", arguments: JSON.stringify({ cmd: "cat /s/d/SKILL.md" }) },
    });
    expect(readCodexRollout([META, STARTED, bad], {}).loads).toEqual([]);
  });
});
