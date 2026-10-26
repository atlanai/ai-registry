import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect } from "vitest";
import { codex } from "#targets/codex.ts";
import { test } from "#test/kit/fixtures.ts";
import type { Target } from "./contract.ts";
import { canonicalId, detectAll, resolveTargets, targetRoot } from "./index.ts";
import { loadTargetFiles } from "./load.ts";

let env: NodeJS.ProcessEnv;
let dir: string;

test.beforeEach(async ({ tmp }) => {
  env = { HOME: tmp, AIREG_HOME: join(tmp, ".aireg") };
  dir = join(tmp, ".aireg", "targets");
  await mkdir(dir, { recursive: true });
});

const TOOL = {
  id: "tool",
  displayName: "Tool",
  roots: { project: ".tool", user: { default: "~/.tool" } },
  kinds: { skill: { shape: "directory", subdir: "skills" } },
};

const save = (name: string, body: unknown) =>
  writeFile(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));

const problems = () => loadTargetFiles(env).skipped.flatMap((file) => file.problems);

describe("target files", () => {
  test("add a target under their own id, beside the built-ins", async () => {
    await save("tool.json", TOOL);
    const targetTable = resolveTargets(env);
    expect(targetTable.tool).toMatchObject({
      displayName: "Tool",
      userRoot: join(env.HOME as string, ".tool"),
      origin: join(dir, "tool.json"),
    });
    expect(targetTable["claude-code"]?.origin).toBe("built-in");
  });

  test("still load from the folder's earlier name, `harnesses/`", async () => {
    const legacy = join(env.AIREG_HOME as string, "harnesses");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "tool.json"), JSON.stringify(TOOL));
    expect(problems()).toEqual([]);
    expect(resolveTargets(env).tool?.origin).toBe(join(legacy, "tool.json"));
  });

  test("read `category`, `coding-agent` when absent, and refuse `shared`", async () => {
    await save("tool.json", { ...TOOL, category: "personal-agent" });
    await save("other.json", { ...TOOL, id: "other" });
    await save("folder.json", { ...TOOL, id: "folder", shared: true });
    const table = resolveTargets(env);
    expect(table.tool?.category).toBe("personal-agent");
    expect(table.other?.category).toBe("coding-agent");
    expect(table.other?.shared).toBe(false);
    expect(table.folder).toBeUndefined();
    expect(table["claude-code"]?.category).toBe("coding-agent");
    expect(table.universal).toMatchObject({ category: "shared-folder", shared: true });
  });

  test("read `kind`, the earlier name of `category`, with a warning", async () => {
    await save("tool.json", { ...TOOL, kind: "shared", detect: "never" });
    await save("coder.json", { ...TOOL, id: "coder", kind: "coding" });
    await save("helper.json", { ...TOOL, id: "helper", kind: "personal" });
    await save("other.json", { ...TOOL, id: "other", kind: "toString" });
    const { files } = loadTargetFiles(env);
    const earlier = (kind: string, category: string) =>
      `It sets "kind": "${kind}", the earlier way to say "category": "${category}"; set that instead.`;
    expect(files.map(({ definition, warnings }) => [definition.id, warnings])).toEqual([
      ["coder", [earlier("coding", "coding-agent")]],
      ["helper", [earlier("personal", "personal-agent")]],
      ["other", ['It sets "kind": "toString", which aireg no longer reads; delete it.']],
      ["tool", [earlier("shared", "shared-folder")]],
    ]);
    const table = resolveTargets(env);
    expect(table.tool).toMatchObject({ category: "shared-folder", shared: true });
    expect(table.coder?.category).toBe("coding-agent");
    expect(table.helper?.category).toBe("personal-agent");
    expect(table.other?.category).toBe("coding-agent");
    expect(table.tool).not.toHaveProperty("kind");
  });

  test("refuse a file with both `kind` and `category`, naming both", async () => {
    await save("tool.json", { ...TOOL, kind: "personal", category: "personal-agent" });
    expect(problems()).toEqual([
      'It sets both "category" and "kind", its earlier name; keep "category".',
    ]);
  });

  test("say to move a file from the folder's earlier name", async () => {
    const legacy = join(env.AIREG_HOME as string, "harnesses");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "tool.json"), JSON.stringify(TOOL));
    expect(loadTargetFiles(env).files[0]?.warnings).toEqual([
      `It is in ${legacy}, the targets folder's earlier name; move it to ${dir}.`,
    ]);
  });

  test("refuse an id defined in both folders, naming both files", async () => {
    const legacy = join(env.AIREG_HOME as string, "harnesses");
    await mkdir(legacy, { recursive: true });
    await save("tool.json", TOOL);
    await writeFile(join(legacy, "tool.json"), JSON.stringify(TOOL));
    const { files, skipped } = loadTargetFiles(env);
    expect(files).toEqual([]);
    expect(skipped.map((file) => file.problems)).toEqual([
      [`It defines "tool", as ${join(legacy, "tool.json")} does too; keep one of them.`],
      [`It defines "tool", as ${join(dir, "tool.json")} does too; keep one of them.`],
    ]);
    expect(resolveTargets(env).tool).toBeUndefined();
  });

  test("give a target other ids, and read the built-ins' earlier ids in `reads`", async () => {
    await save("tool.json", {
      ...TOOL,
      aliases: ["old-tool"],
      reads: { skill: ["agents", "tool"] },
    });
    const table = resolveTargets(env);
    expect(problems()).toEqual([]);
    expect(canonicalId(table, "old-tool")).toBe("tool");
    expect(table.tool?.reads.skill).toEqual(["universal", "tool"]);
  });

  test("keep a built-in's other ids when a file replaces it without naming its own", async () => {
    await save("claude-code.json", { ...TOOL, id: "claude-code", overrides: true });
    expect(problems()).toEqual([]);
    expect(resolveTargets(env)["claude-code"]?.aliases).toEqual(["claude"]);
    expect(canonicalId(resolveTargets(env), "claude")).toBe("claude-code");
  });

  test("let a sibling read a replaced built-in by an id the replacement inherits", async () => {
    await save("claude-code.json", { ...TOOL, id: "claude-code", overrides: true });
    await save("tool.json", { ...TOOL, reads: { skill: ["claude", "tool"] } });
    expect(problems()).toEqual([]);
    expect(resolveTargets(env).tool?.reads.skill).toEqual(["claude-code", "tool"]);
  });

  test("replace a built-in from a 0.1 file named by its earlier id, with a warning", async () => {
    const legacy = join(env.AIREG_HOME as string, "harnesses");
    await mkdir(legacy, { recursive: true });
    await writeFile(
      join(legacy, "claude.json"),
      JSON.stringify({ ...TOOL, id: "claude", overrides: true }),
    );
    expect(problems()).toEqual([]);
    const table = resolveTargets(env);
    expect(table["claude-code"]).toMatchObject({
      displayName: "Tool",
      aliases: ["claude"],
      origin: join(legacy, "claude.json"),
    });
    expect(table.claude).toBeUndefined();
    expect(loadTargetFiles(env).files[0]?.warnings).toEqual([
      'It defines "claude", the earlier id of "claude-code"; set its id to "claude-code" and name it claude-code.json.',
      `It is in ${legacy}, the targets folder's earlier name; move it to ${dir}.`,
    ]);
  });

  test("still refuse a built-in's earlier id in the targets folder", async () => {
    await save("claude.json", { ...TOOL, id: "claude", overrides: true });
    expect(problems()).toEqual([
      '"claude" is another name for the built-in target "claude-code"; name the file claude-code.json and its id "claude-code" to replace it.',
    ]);
    expect(resolveTargets(env)["claude-code"]?.origin).toBe("built-in");
  });

  test("resolve a JSON copy of a built-in to the same target", async () => {
    const { default: _, importable: __, ...definition } = codex;
    const { caller: ___, ...detect } = definition.detect as Exclude<
      typeof definition.detect,
      "never" | undefined
    >;
    await save("codex.json", { ...definition, detect, overrides: true });
    const builtIn = resolveTargets({ ...env, AIREG_HOME: join(dir, "none") }).codex;
    expect(problems()).toEqual([]);
    expect({ ...resolveTargets(env).codex, origin: "built-in" }).toEqual(builtIn);
  });

  test("move a user root to its place inside the folder its variable names", async () => {
    const roots = {
      project: ".tool",
      user: { default: "~/.tool", env: "TOOL_HOME", within: ".tool" },
    };
    await save("tool.json", { ...TOOL, roots });
    const tool = resolveTargets(env).tool as Target;
    expect(targetRoot(tool, "user", "/work", { TOOL_HOME: "/elsewhere" })).toBe(
      resolve("/elsewhere", ".tool"),
    );
    expect(targetRoot(tool, "user", "/work", {})).toBe(join(env.HOME as string, ".tool"));
  });

  test("detect nothing from a project folder they say proves nothing", async ({ tmp }) => {
    await save("tool.json", { ...TOOL, detect: { projectRoot: false } });
    const project = join(tmp, "project");
    await mkdir(join(project, ".tool"), { recursive: true });
    const found = detectAll(resolveTargets(env), project, env).find(
      (each) => each.target.name === "tool",
    );
    expect(found?.detected).toBe(false);
  });

  test("give each profile folder a target of its own", async () => {
    await save("tool.json", { ...TOOL, profiles: { root: "~/.tool/profiles/{profile}" } });
    await mkdir(join(env.HOME as string, ".tool", "profiles", "work"), { recursive: true });
    await mkdir(join(env.HOME as string, ".tool", "profiles", "Not A Name"), { recursive: true });
    const targetTable = resolveTargets(env);
    expect(targetTable["tool:work"]).toMatchObject({
      displayName: "Tool (work)",
      userRoot: join(env.HOME as string, ".tool", "profiles", "work"),
    });
    expect(Object.keys(targetTable).filter((id) => id.startsWith("tool"))).toEqual([
      "tool",
      "tool:work",
    ]);
    // A profile is this machine's alone, so a project never installs into it.
    expect(targetTable["tool:work"]?.kinds.skill?.scope).toBe("user");
  });

  test("read `instances`, the earlier name of `profiles`, with a warning", async () => {
    await save("tool.json", { ...TOOL, instances: { root: "~/.tool/profiles/{profile}" } });
    await mkdir(join(env.HOME as string, ".tool", "profiles", "work"), { recursive: true });
    expect(loadTargetFiles(env).files[0]?.warnings).toEqual([
      'It sets "instances", the earlier name of "profiles"; rename it.',
    ]);
    expect(resolveTargets(env)["tool:work"]?.userRoot).toBe(
      join(env.HOME as string, ".tool", "profiles", "work"),
    );
  });

  test.each([
    ["is not JSON", "{ id: tool", /not valid JSON/],
    [
      "sets both `profiles` and `instances`",
      {
        ...TOOL,
        profiles: { root: "~/.tool/a/{profile}" },
        instances: { root: "~/.tool/b/{profile}" },
      },
      /both "profiles" and "instances", its earlier name/,
    ],
    ["has an unknown key", { ...TOOL, colour: "red" }, /unknown key "colour"/],
    [
      "names a codec that is not built in",
      {
        ...TOOL,
        kinds: {
          agent: { shape: "file", subdir: "agents", extension: ".md", codec: { id: "mine" } },
        },
      },
      /codec/,
    ],
    [
      "puts its user root outside your home folder",
      { ...TOOL, roots: { project: ".tool", user: { default: "/etc/tool" } } },
      /roots\/user\/default/,
    ],
    [
      "climbs out of its project root",
      { ...TOOL, roots: { project: "../tool", user: { default: "~/.tool" } } },
      /not a path inside its root/,
    ],
    [
      "climbs out of its root to a config file",
      {
        ...TOOL,
        kinds: {
          skill: {
            shape: "directory",
            subdir: "skills",
            register: [{ file: "../c.yaml", format: "yaml", at: ["d"], append: "{root}" }],
          },
        },
      },
      /not a path inside its root/,
    ],
    [
      "climbs out of a plugin to a manifest",
      {
        ...TOOL,
        kinds: {
          plugin: { shape: "directory", subdir: "plugins", manifest: [{ path: "/etc/p.json" }] },
        },
      },
      /not a path inside its root/,
    ],
    [
      "detects with a shell command",
      { ...TOOL, detect: { binary: ["tool --version || true"] } },
      /never a shell command/,
    ],
    [
      "checks its version with a shell command",
      { ...TOOL, verified: { command: "tool --version", range: ">=1" } },
      /never a shell command/,
    ],
    ["takes a built-in id", { ...TOOL, id: "claude-code" }, /set "overrides": true/],
    [
      "takes another name of a built-in",
      { ...TOOL, id: "claude" },
      /"claude" is another name for the built-in target "claude-code"; name the file claude-code\.json/,
    ],
    [
      "gives itself another name a built-in has",
      { ...TOOL, aliases: ["agents"] },
      /the alias "agents" already names the target "universal"/,
    ],
  ])("are skipped when one %s", async (_, body, problem) => {
    const id = typeof body === "string" ? "tool" : (body as { id: string }).id;
    await save(`${id}.json`, body);
    expect(problems().join("\n")).toMatch(problem);
    expect(resolveTargets(env)["claude-code"]?.origin).toBe("built-in");
  });

  test("are skipped when one names an id other than its own", async () => {
    await save("other.json", TOOL);
    expect(problems()).toEqual(['It defines "tool", not its own name.']);
  });

  test("are read from your user scope alone, never through a link to elsewhere", async ({
    tmp,
  }) => {
    const project = join(tmp, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "tool.json"), JSON.stringify(TOOL));
    await symlink(join(project, "tool.json"), join(dir, "tool.json"));
    expect(problems()).toEqual(["It links to a file outside your targets folder."]);
    expect(resolveTargets(env).tool).toBeUndefined();
  });
});
