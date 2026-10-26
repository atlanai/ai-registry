import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { Printer } from "#core/output.ts";
import { test } from "#test/kit/fixtures.ts";
import { allCommands, type CommandContext, lookup, RESERVED } from "./index.ts";
import { foundSummary, run } from "./targets.ts";

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

describe("targets", () => {
  let cwd: string;

  test.beforeEach(async ({ tmp }) => {
    cwd = tmp;
    vi.stubEnv("HOME", cwd);
    vi.stubEnv("USERPROFILE", cwd);
    vi.stubEnv("AIREG_HOME", join(cwd, ".aireg"));
    vi.stubEnv("PATH", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(cwd, ".claude"));
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("COPILOT_HOME", "");
    vi.stubEnv("GEMINI_CLI_HOME", "");
    vi.stubEnv("OPENCODE_CONFIG_DIR", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  test("answers to its earlier name, `harnesses`, which no list of commands shows", async () => {
    expect((await lookup("harnesses", cwd))?.name).toBe("targets");
    expect(RESERVED.has("harnesses")).toBe(true);
    const listed = (await allCommands(cwd)).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(listed).toContain("targets");
    expect(listed).not.toContain("harnesses");
  });

  test("lists every name --for takes, by name and detection only", async () => {
    const writes: string[] = [];
    await run(context(cwd, writes));
    const payload = JSON.parse(writes.join("")) as {
      data: { targets: Record<string, unknown>[] };
    };
    // In the order the text lists them, with the shared folder last.
    const builtIn = { shared: false, origin: "built-in" };
    expect(payload.data.targets).toEqual([
      {
        name: "claude-code",
        aliases: ["claude"],
        displayName: "Claude Code",
        ...builtIn,
        detected: true,
        by: "env",
      },
      { name: "codex", aliases: [], displayName: "Codex", ...builtIn, detected: false },
      { name: "cursor", aliases: [], displayName: "Cursor", ...builtIn, detected: false },
      {
        name: "gemini-cli",
        aliases: ["gemini"],
        displayName: "Gemini CLI",
        ...builtIn,
        detected: false,
      },
      {
        name: "github-copilot",
        aliases: ["copilot"],
        displayName: "GitHub Copilot",
        ...builtIn,
        detected: false,
      },
      { name: "opencode", aliases: [], displayName: "OpenCode", ...builtIn, detected: false },
      {
        name: "universal",
        aliases: ["agents"],
        displayName: "Shared .agents folder",
        shared: true,
        detected: false,
        origin: "built-in",
      },
    ]);
  });

  test("lists the coding agents this machine has, and every one with --all, but no folder row", async () => {
    const found: string[] = [];
    await run(context(cwd, found, "text"));
    const lines = found.join("").split("\n");
    expect(lines).toContain("  target       id           aliases  status  where");
    expect(lines).toContain(
      "  Claude Code  claude-code  claude   found   from its environment variables",
    );
    expect(lines.some((line) => /^ +(Codex|Cursor|agents|Shared)/.test(line))).toBe(false);
    expect(lines).toContain("Found 1 of 6 supported targets on this machine.");
    expect(lines).toContain("hint: Run `aireg targets --all` to see every one.");
    expect(lines).toContain(
      "hint: Use `--for universal`, or `agents`, for the shared .agents folder.",
    );

    const every: string[] = [];
    await run(context(cwd, every, "text", ["--all"]));
    const all = every.join("").split("\n");
    expect(every.join("")).toMatch(/^ +Cursor +cursor +not found$/m);
    expect(every.join("")).toMatch(/^ +GitHub Copilot +github-copilot +copilot +not found$/m);
    expect(all.some((line) => line.includes("--all"))).toBe(false);
    expect(all.some((line) => /^ +Shared/.test(line))).toBe(false);
  });

  test("finds no GitHub Copilot from a project's .github folder alone", async () => {
    await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
    const writes: string[] = [];
    await run(context(cwd, writes));
    const { data } = JSON.parse(writes.join("")) as {
      data: { targets: { name: string; detected: boolean }[] };
    };
    expect(data.targets.find((item) => item.name === "github-copilot")?.detected).toBe(false);
  });

  test("says which file defines a target, and skips a broken one with a warning", async () => {
    const dir = join(cwd, ".aireg", "targets");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tool.json"), JSON.stringify(TOOL));
    await writeFile(join(dir, "broken.json"), "{");
    const writes: string[] = [];
    await run(context(cwd, writes, "text"));
    const text = writes.join("");
    expect(text).toMatch(/Tool +tool +not found +~\/\.aireg\/targets\/tool\.json/);
    expect(text).toContain("Skipped ~/.aireg/targets/broken.json: it is not valid JSON.");
  });

  test("warns of a file that still says `kind`, which it reads as `category`", async () => {
    const dir = join(cwd, ".aireg", "targets");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "tool.json"),
      JSON.stringify({
        ...TOOL,
        kind: "shared",
        detect: "never",
        profiles: { root: "~/.tool/{profile}" },
      }),
    );
    await mkdir(join(cwd, ".tool", "work"), { recursive: true });
    const writes: string[] = [];
    await run(context(cwd, writes, "text"));
    expect(writes.join("")).toContain(
      'warning: Read ~/.aireg/targets/tool.json, but it sets "kind": "shared", the earlier way to say "category": "shared-folder"; set that instead.',
    );
    expect(writes.join("")).toContain("hint: Use `--for tool` for the shared .tool folder.");
    expect(writes.join("")).not.toContain("--for tool:work");
  });

  test("shows a target by its id or an alias", async () => {
    for (const id of ["claude", "claude-code"]) {
      const writes: string[] = [];
      await run(context(cwd, writes, "json", ["show", id]));
      const { data } = JSON.parse(writes.join("")) as { data: { target: { name: string } } };
      expect(data.target.name).toBe("claude-code");
    }
  });

  test("shows a target as aireg resolved it", async () => {
    const writes: string[] = [];
    await run(context(cwd, writes, "json", ["show", "codex"]));
    const { data } = JSON.parse(writes.join("")) as { data: { target: Record<string, unknown> } };
    expect(data.target).toMatchObject({
      name: "codex",
      origin: "built-in",
      projectRoot: ".codex",
    });
    expect(data.target).not.toHaveProperty("category");
    await expect(run(context(cwd, [], "json", ["show", "ghost"]))).rejects.toThrow(
      'No target named "ghost".',
    );
  });

  test("checks a file against the targets your other files define", async () => {
    await mkdir(join(cwd, ".aireg", "targets"), { recursive: true });
    await writeFile(join(cwd, ".aireg", "targets", "tool.json"), JSON.stringify(TOOL));
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
    expect(good.join("")).toContain('tool.json defines the target "tool".');
    expect(good.join("")).toContain("Save it as ~/.aireg/targets/tool.json for aireg to use it.");

    await writeFile(join(cwd, "bad.json"), JSON.stringify({ ...TOOL, colour: "red" }));
    const bad: string[] = [];
    const checked = context(cwd, bad, "text", ["check", "bad.json"]);
    await run(checked);
    expect(checked.exit).toBe(1);
    expect(bad.join("")).toContain('The file has an unknown key "colour".');
  });

  test("sums up how many of the supported targets this machine has", () => {
    expect(foundSummary(3, 3)).toBe("Found all 3 supported targets on this machine.");
    expect(foundSummary(1, 3)).toBe("Found 1 of 3 supported targets on this machine.");
    expect(foundSummary(0, 3)).toBe("No supported target found on this machine.");
  });
});
