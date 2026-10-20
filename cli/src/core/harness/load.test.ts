import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect } from "vitest";
import { codex } from "#harnesses/codex.ts";
import { test } from "#test/kit/fixtures.ts";
import type { Target } from "./contract.ts";
import { detectAll, resolveHarnesses, targetRoot } from "./index.ts";
import { loadHarnessFiles } from "./load.ts";

let env: NodeJS.ProcessEnv;
let dir: string;

test.beforeEach(async ({ tmp }) => {
  env = { HOME: tmp, AIREG_HOME: join(tmp, ".aireg") };
  dir = join(tmp, ".aireg", "harnesses");
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

const problems = () => loadHarnessFiles(env).skipped.flatMap((file) => file.problems);

describe("harness files", () => {
  test("add a harness under their own id, beside the built-ins", async () => {
    await save("tool.json", TOOL);
    const harnesses = resolveHarnesses(env);
    expect(harnesses.tool).toMatchObject({
      displayName: "Tool",
      userRoot: join(env.HOME as string, ".tool"),
      origin: join(dir, "tool.json"),
    });
    expect(harnesses.claude?.origin).toBe("built-in");
  });

  test("resolve a JSON copy of a built-in to the same target", async () => {
    const { default: _, importable: __, ...definition } = codex;
    const { caller: ___, ...detect } = definition.detect as Exclude<
      typeof definition.detect,
      "never" | undefined
    >;
    await save("codex.json", { ...definition, detect, overrides: true });
    const builtIn = resolveHarnesses({ ...env, AIREG_HOME: join(dir, "none") }).codex;
    expect(problems()).toEqual([]);
    expect({ ...resolveHarnesses(env).codex, origin: "built-in" }).toEqual(builtIn);
  });

  test("move a user root to its place inside the folder its variable names", async () => {
    const roots = {
      project: ".tool",
      user: { default: "~/.tool", env: "TOOL_HOME", within: ".tool" },
    };
    await save("tool.json", { ...TOOL, roots });
    const tool = resolveHarnesses(env).tool as Target;
    expect(targetRoot(tool, "user", "/work", { TOOL_HOME: "/elsewhere" })).toBe(
      resolve("/elsewhere", ".tool"),
    );
    expect(targetRoot(tool, "user", "/work", {})).toBe(join(env.HOME as string, ".tool"));
  });

  test("detect nothing from a project folder they say proves nothing", async ({ tmp }) => {
    await save("tool.json", { ...TOOL, detect: { projectRoot: false } });
    const project = join(tmp, "project");
    await mkdir(join(project, ".tool"), { recursive: true });
    const found = detectAll(resolveHarnesses(env), project, env).find(
      (each) => each.target.name === "tool",
    );
    expect(found?.detected).toBe(false);
  });

  test("give each profile folder a harness of its own", async () => {
    await save("tool.json", { ...TOOL, instances: { root: "~/.tool/profiles/{profile}" } });
    await mkdir(join(env.HOME as string, ".tool", "profiles", "work"), { recursive: true });
    await mkdir(join(env.HOME as string, ".tool", "profiles", "Not A Name"), { recursive: true });
    const harnesses = resolveHarnesses(env);
    expect(harnesses["tool:work"]).toMatchObject({
      displayName: "Tool (work)",
      userRoot: join(env.HOME as string, ".tool", "profiles", "work"),
    });
    expect(Object.keys(harnesses).filter((id) => id.startsWith("tool"))).toEqual([
      "tool",
      "tool:work",
    ]);
    // A profile is this machine's alone, so a project never installs into it.
    expect(harnesses["tool:work"]?.kinds.skill?.scope).toBe("user");
  });

  test.each([
    ["is not JSON", "{ id: tool", /not valid JSON/],
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
    ["takes a built-in id", { ...TOOL, id: "claude" }, /set "overrides": true/],
  ])("are skipped when one %s", async (_, body, problem) => {
    const id = typeof body === "string" ? "tool" : (body as { id: string }).id;
    await save(`${id}.json`, body);
    expect(problems().join("\n")).toMatch(problem);
    expect(resolveHarnesses(env).claude?.origin).toBe("built-in");
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
    expect(problems()).toEqual(["It links to a file outside your harnesses folder."]);
    expect(resolveHarnesses(env).tool).toBeUndefined();
  });
});
