import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { Printer } from "#core/output.ts";
import { test } from "#test/kit/fixtures.ts";
import { foundSummary, run } from "./harnesses.ts";
import type { CommandContext } from "./index.ts";

function context(
  cwd: string,
  writes: string[],
  format: "json" | "text" = "json",
  argv: string[] = [],
): CommandContext {
  return {
    argv,
    cwd,
    printer: new Printer({
      format,
      color: "never",
      out: { write: (chunk: string) => writes.push(chunk), isTTY: false },
      err: { write: (chunk: string) => writes.push(chunk), isTTY: false },
    }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}

const TOOL = {
  id: "tool",
  displayName: "Tool",
  roots: { project: ".tool", user: { default: "~/.tool" } },
  kinds: { skill: { shape: "directory", subdir: "skills" } },
};

describe("harnesses", () => {
  let cwd: string;

  test.beforeEach(async ({ tmp }) => {
    cwd = tmp;
    vi.stubEnv("HOME", cwd);
    vi.stubEnv("USERPROFILE", cwd);
    vi.stubEnv("AIREG_HOME", join(cwd, ".aireg"));
    vi.stubEnv("PATH", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(cwd, ".claude"));
    vi.stubEnv("CODEX_HOME", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  test("lists every name --for takes, by name and detection only", async () => {
    const writes: string[] = [];
    await run(context(cwd, writes));
    const payload = JSON.parse(writes.join("")) as {
      data: { harnesses: Record<string, unknown>[] };
    };
    // In the order the text lists them, with the shared folder last.
    const builtIn = { kind: "coding", shared: false, origin: "built-in" };
    expect(payload.data.harnesses).toEqual([
      { name: "claude", displayName: "Claude Code", ...builtIn, detected: true, by: "env" },
      { name: "codex", displayName: "Codex", ...builtIn, detected: false },
      { name: "cursor", displayName: "Cursor", ...builtIn, detected: false },
      {
        name: "agents",
        displayName: "Shared .agents folder",
        kind: "shared",
        shared: true,
        detected: false,
        origin: "built-in",
      },
    ]);
  });

  test("lists the coding agents this machine has, and every one with --all, but no folder", async () => {
    const found: string[] = [];
    await run(context(cwd, found, "text"));
    const lines = found.join("").split("\n");
    expect(lines).toContain("  harness      id      status  where");
    expect(lines).toContain("  Claude Code  claude  found   from its environment variables");
    expect(lines.some((line) => /^ +(Codex|Cursor|agents|Shared)/.test(line))).toBe(false);
    expect(lines).toContain("Found 1 of 3 supported harnesses on this machine.");
    expect(lines).toContain("hint: Run `aireg harnesses --all` to see every one.");

    const every: string[] = [];
    await run(context(cwd, every, "text", ["--all"]));
    const all = every.join("").split("\n");
    expect(every.join("")).toMatch(/^ +Cursor +cursor +not found$/m);
    expect(all.some((line) => line.includes("--all"))).toBe(false);
    expect(all.some((line) => line.includes("shared"))).toBe(false);
  });

  test("says which file defines a harness, and skips a broken one with a warning", async () => {
    const dir = join(cwd, ".aireg", "harnesses");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tool.json"), JSON.stringify(TOOL));
    await writeFile(join(dir, "broken.json"), "{");
    const writes: string[] = [];
    await run(context(cwd, writes, "text"));
    const text = writes.join("");
    expect(text).toMatch(/Tool +tool +not found +~\/\.aireg\/harnesses\/tool\.json/);
    expect(text).toContain("Skipped ~/.aireg/harnesses/broken.json: it is not valid JSON.");
  });

  test("shows a harness as aireg resolved it", async () => {
    const writes: string[] = [];
    await run(context(cwd, writes, "json", ["show", "codex"]));
    const { data } = JSON.parse(writes.join("")) as { data: { harness: Record<string, unknown> } };
    expect(data.harness).toMatchObject({
      name: "codex",
      origin: "built-in",
      projectRoot: ".codex",
    });
    await expect(run(context(cwd, [], "json", ["show", "ghost"]))).rejects.toThrow(
      'No harness named "ghost".',
    );
  });

  test("checks a file against the harnesses your other files define", async () => {
    await mkdir(join(cwd, ".aireg", "harnesses"), { recursive: true });
    await writeFile(join(cwd, ".aireg", "harnesses", "tool.json"), JSON.stringify(TOOL));
    const reader = { ...TOOL, id: "reader", reads: { skill: ["tool"] } };
    await writeFile(join(cwd, "reader.json"), JSON.stringify(reader));
    const checked = context(cwd, [], "json", ["check", "reader.json"]);
    await run(checked);
    expect(checked.exit).toBeUndefined();
  });

  test("names its actions when given one it does not have", async () => {
    await expect(run(context(cwd, [], "json", ["bogus"]))).rejects.toThrow(/Unknown/);
  });

  test("checks a file wherever it is, and says what is wrong with it", async () => {
    await writeFile(join(cwd, "tool.json"), JSON.stringify(TOOL));
    const good: string[] = [];
    await run(context(cwd, good, "text", ["check", "tool.json"]));
    expect(good.join("")).toContain('tool.json defines the harness "tool".');
    expect(good.join("")).toContain("Save it as ~/.aireg/harnesses/tool.json for aireg to use it.");

    await writeFile(join(cwd, "bad.json"), JSON.stringify({ ...TOOL, colour: "red" }));
    const bad: string[] = [];
    const checked = context(cwd, bad, "text", ["check", "bad.json"]);
    await run(checked);
    expect(checked.exit).toBe(1);
    expect(bad.join("")).toContain('The file has an unknown key "colour".');
  });

  test("sums up how many of the supported harnesses this machine has", () => {
    expect(foundSummary(3, 3)).toBe("Found all 3 supported harnesses on this machine.");
    expect(foundSummary(1, 3)).toBe("Found 1 of 3 supported harnesses on this machine.");
    expect(foundSummary(0, 3)).toBe("No supported harness found on this machine.");
  });
});
