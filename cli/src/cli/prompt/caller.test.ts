import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blocker, callingAgent, explain, SIGNALS } from "./caller.ts";

const DOCS = readFileSync(
  new URL("../../../../docs/reference/environment.md", import.meta.url),
  "utf8",
);

const human = { json: false, yes: false, isTTY: true, env: {} as NodeJS.ProcessEnv };

describe("callingAgent", () => {
  it("finds nothing when a person is at the keyboard", () => {
    expect(callingAgent({})).toBeUndefined();
  });

  it("reads the cross-vendor variable first", () => {
    expect(callingAgent({ AI_AGENT: "something-new", CLAUDECODE: "1" })).toBe("something-new");
  });

  it("recognizes the signals the agents actually set", () => {
    expect(callingAgent({ CLAUDECODE: "1" })).toBe("claude");
    expect(callingAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(callingAgent({ CODEX_THREAD_ID: "abc" })).toBe("codex");
    expect(callingAgent({ COPILOT_CLI: "1" })).toBe("copilot");
    expect(callingAgent({ REPL_ID: "abc" })).toBe("replit");
  });

  it("takes no variable the agent does not set", () => {
    expect(callingAgent({ CLAUDE_CODE: "1" })).toBeUndefined();
    expect(callingAgent({ CURSOR_TRACE_ID: "abc" })).toBeUndefined();
  });

  it("takes no setting a person exports for an agent as a sign of it", () => {
    expect(callingAgent({ COPILOT_MODEL: "auto", COPILOT_ALLOW_ALL: "true" })).toBeUndefined();
  });

  it("ignores a variable that is set but empty", () => {
    expect(callingAgent({ CLAUDECODE: "  " })).toBeUndefined();
  });
});

describe("blocker", () => {
  it("allows prompting for a person on a terminal", () => {
    expect(blocker(human)).toBeUndefined();
  });

  it("puts an explicit flag ahead of the environment", () => {
    expect(blocker({ ...human, json: true, isTTY: false })).toEqual({ kind: "json" });
    expect(blocker({ ...human, yes: true })).toEqual({ kind: "yes" });
  });

  it("blames a missing terminal on the terminal, not on CI", () => {
    expect(blocker({ ...human, isTTY: false, env: { CI: "true" } })).toEqual({ kind: "tty" });
  });

  it("refuses to prompt an agent that cannot answer", () => {
    expect(blocker({ ...human, env: { CLAUDECODE: "1" } })).toEqual({
      kind: "agent",
      agent: "claude",
    });
  });

  it("refuses to prompt in CI", () => {
    expect(blocker({ ...human, env: { CI: "true" } })).toEqual({ kind: "ci" });
  });
});

describe("explain", () => {
  it("names the agent so the line reads as a sentence", () => {
    expect(explain({ kind: "agent", agent: "codex" })).toBe("it is running inside codex");
  });
});

describe("the environment reference", () => {
  it.each(["AI_AGENT", "CI", ...SIGNALS.flatMap((signal) => signal.env)])(
    "documents %s",
    (name) => {
      expect(DOCS).toContain(`\`${name}\``);
    },
  );
});
