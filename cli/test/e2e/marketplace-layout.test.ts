import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { marketplace, skillsFolder } from "#test/kit/builders/layouts.ts";
import { type Aireg, test } from "#test/kit/fixtures.ts";
import { BIN } from "#test/kit/run.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";

const init = async (aireg: Aireg, harnesses = "claude,codex,cursor,agents") =>
  expect((await aireg(["init", "--for", harnesses])).code).toBe(0);

const read = (path: string) => readFile(path, "utf8");

const locked = async (project: string) =>
  Object.keys(
    (parse(await read(lockPath(project))) as { artifacts: Record<string, unknown> }).artifacts,
  ).sort();

describe("a plugin marketplace", () => {
  test("installs each plugin whole where a harness loads plugins, and as parts elsewhere", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg);
    const added = await aireg(["add", root, "--all", "--trust", "deploy-kit"]);
    expect(added.code, added.stderr).toBe(0);

    const claude = join(project, ".claude", "skills");
    // Its own manifest, copied; and one written from the marketplace entry for the other.
    expect(
      JSON.parse(await read(join(claude, "docs-kit", ".claude-plugin", "plugin.json"))),
    ).toEqual({
      name: "docs-kit",
      version: "1.0.0",
      description: "Works with documents.",
    });
    expect(
      JSON.parse(await read(join(claude, "deploy-kit", ".claude-plugin", "plugin.json"))),
    ).toMatchObject({
      name: "deploy-kit",
      description: "Ships builds.",
    });
    for (const path of ["skills/pdf/SKILL.md", "commands/summarize.md"]) {
      expect(existsSync(join(claude, "docs-kit", path)), path).toBe(true);
    }
    for (const path of ["hooks/hooks.json", ".mcp.json"]) {
      expect(existsSync(join(claude, "deploy-kit", path)), path).toBe(true);
    }

    const agents = join(project, ".agents", "skills");
    for (const name of ["pdf", "xlsx", "ship"]) {
      expect(existsSync(join(agents, name, "SKILL.md")), name).toBe(true);
    }
    // A command, rendered as a skill a person invokes; the stored copy is untouched.
    expect(await read(join(agents, "docs-kit-summarize", "SKILL.md"))).toBe(
      '---\nname: docs-kit-summarize\ndescription: "Summarize the open file."\ndisable-model-invocation: true\n---\nSummarize $ARGUMENTS.\n',
    );
    expect(await read(join(agents, "docs-kit-summarize", "agents", "openai.yaml"))).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
    expect(await locked(project)).toEqual(["deploy-kit", "docs-kit"]);
    expect(await read(manifestPath(project))).toContain("layout: marketplace");
  }, 60_000);

  test("leaves a command out for a harness that would run it on its own, and says so", async ({
    aireg,
    home,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await mkdir(join(home.aireg, "harnesses"), { recursive: true });
    const tool = {
      id: "tool",
      displayName: "Tool",
      roots: { project: ".tool", user: { default: "~/.tool" } },
      kinds: {
        plugin: { shape: "contents" },
        skill: {
          shape: "directory",
          subdir: "skills",
          keys: { "disable-model-invocation": false },
        },
      },
    };
    await writeFile(join(home.aireg, "harnesses", "tool.json"), JSON.stringify(tool));
    await init(aireg, "tool");
    const added = await aireg(["add", root, "--all", "--trust", "deploy-kit"]);
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, ".tool", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".tool", "skills", "docs-kit-summarize"))).toBe(false);
    expect(added.stderr).toContain(
      "Did not install docs-kit-summarize for Tool: it sets disable-model-invocation, which Tool cannot read.",
    );
  }, 60_000);

  test("prints the trust step for the agents a plugin brings into a project", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "toolkit"))
      .json(".claude-plugin/plugin.json", { name: "toolkit" })
      .skill("skills/ship")
      .agent("agents/planner.md")
      .write();
    await init(aireg, "codex");
    const added = await aireg(["add", root, "--all"]);
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, ".codex", "agents", "planner.toml"))).toBe(true);
    expect(added.stdout + added.stderr).toContain(
      "hint: Codex loads agents here only once you trust them: run `codex`.",
    );
  }, 60_000);

  test("names the shared folder it left a command out of by its path", async ({
    aireg,
    home,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await mkdir(join(home.aireg, "harnesses"), { recursive: true });
    const tool = {
      id: "tool",
      displayName: "Tool",
      roots: { project: ".tool", user: { default: "~/.tool" } },
      reads: { skill: ["agents"] },
      kinds: {
        plugin: { shape: "contents" },
        skill: {
          shape: "directory",
          subdir: "skills",
          keys: { "disable-model-invocation": false },
        },
      },
    };
    await writeFile(join(home.aireg, "harnesses", "tool.json"), JSON.stringify(tool));
    await init(aireg, "tool");
    const added = await aireg(["add", root, "--all", "--trust", "deploy-kit"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(
      "Did not install docs-kit-summarize for .agents: it sets disable-model-invocation, which Tool cannot read.",
    );
  }, 60_000);

  test("asks for trust before a plugin that runs things as you, and records it", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    const refused = await aireg(["add", root, "--all"], { input: "" });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      'Did not install "deploy-kit", which carries hooks and MCP servers that run as you.',
    );
    expect(refused.stderr).toContain("`aireg add acme-tools/deploy-kit --trust deploy-kit`");
    expect(await locked(project)).toEqual(["docs-kit"]);

    // The hint, run as printed.
    const trusted = await aireg(["add", "acme-tools/deploy-kit", "--trust", "deploy-kit"]);
    expect(trusted.code, trusted.stderr).toBe(0);
    expect(await locked(project)).toEqual(["deploy-kit", "docs-kit"]);
    expect(await read(manifestPath(project))).toContain("trust:\n      - deploy-kit");
    expect((await aireg(["install"])).code).toBe(0);
  }, 60_000);

  // util-linux's `script` runs aireg on a terminal of its own; other systems' `script` differs.
  test.runIf(process.platform === "linux")(
    "asks on a terminal before a plugin the address names exactly",
    async ({ aireg, home, project, tmp }) => {
      const root = await marketplace(join(tmp, "mkt")).write();
      await init(aireg, "claude");
      expect((await aireg(["registry", "add", root])).code).toBe(0);
      const command = `${process.execPath} ${BIN} add acme-tools/deploy-kit`;
      // Under CI aireg asks nothing, as it should, and its prompts draw no frames; this run
      // stands in for a person's terminal, so neither variable is passed on at all.
      const { CI: _ci, CONTINUOUS_INTEGRATION: _ci2, ...env } = { ...process.env, ...home.env };
      const child = spawn("script", ["-qec", command, "/dev/null"], {
        cwd: project,
        env: { ...env, NO_COLOR: "1" },
      });
      let said = "";
      // Keys sent before the prompt reads its input are lost, so each drawing of it is answered.
      child.stdout.on("data", (chunk: Buffer) => {
        said += chunk.toString();
        if (chunk.toString().includes("Install it?")) child.stdin.write("y\r");
      });
      const code = await new Promise((done) => child.on("close", done));
      expect(said).toContain("deploy-kit carries hooks and MCP servers");
      expect(code).toBe(0);
      expect(await locked(project)).toEqual(["deploy-kit"]);
      expect(await read(manifestPath(project))).toContain("trust:\n      - deploy-kit");
    },
    60_000,
  );

  test("leaves the manifest as it was when the one plugin an add names is refused", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const before = await read(manifestPath(project));
    const refused = await aireg(["add", "acme-tools/deploy-kit"], { input: "" });
    expect(refused.code).toBe(2);
    expect(await read(manifestPath(project))).toBe(before);
    expect((await aireg(["install"])).code).toBe(0);
  }, 60_000);

  test("does not take a plugin's own parts for skills written here", async ({ aireg, tmp }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "agents");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    expect((await aireg(["add", "acme-tools/docs-kit", "-y"])).code).toBe(0);
    const synced = await aireg(["sync"]);
    expect(`${synced.stdout}${synced.stderr}`).not.toContain("published nowhere");
    expect(synced.code, synced.stdout).toBe(0);
  }, 60_000);

  test("does not call a plugin's own parts new to a whole marketplace", async ({ aireg, tmp }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["add", root, "--all", "--trust", "deploy-kit"])).code).toBe(0);
    const outdated = await aireg(["outdated"]);
    expect(outdated.stdout).not.toContain("new");
    expect(outdated.code, outdated.stdout).toBe(0);
  }, 60_000);

  test("keeps what a trusted plugin runs on record through an install that reads nothing", async ({
    aireg,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["add", root, "--all", "--trust", "deploy-kit"])).code).toBe(0);
    expect((await aireg(["install"])).code).toBe(0);
    const synced = await aireg(["sync"]);
    expect(synced.stdout).not.toContain("adds or changes");
    expect(synced.code, synced.stdout).toBe(0);
  }, 60_000);

  test("lets a sync take no change to what a plugin runs, trusted or not", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["add", root, "--all", "--trust", "deploy-kit"])).code).toBe(0);
    const before = await read(lockPath(project));
    await skillsFolder(root)
      .json("plugins/deploy-kit/.mcp.json", { mcpServers: { other: { command: "other-mcp" } } })
      .json("plugins/docs-kit/hooks/hooks.json", { hooks: {} })
      .write();
    try {
      const synced = await aireg(["sync"]);
      expect(synced.code).toBe(3);
      const said = `${synced.stdout}${synced.stderr}`;
      expect(said).toContain("its new version adds or changes the hooks and MCP servers it runs");
      expect(said).toContain("it now carries hooks, which no entry trusts");
      expect(await read(lockPath(project))).toBe(before);
    } finally {
      await aireg(["daemon", "stop"]);
    }
  }, 60_000);

  test("reads the Claude Code marketplace when the Codex one lists other plugins, and says so", async ({
    aireg,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt"))
      .json(".agents/plugins/marketplace.json", {
        name: "acme-tools",
        plugins: [{ name: "docs-kit", source: { source: "local", path: "./plugins/docs-kit" } }],
      })
      .write();
    await init(aireg, "claude");
    const shown = await aireg(["registry", "show", root]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).toContain(
      'The two marketplace files list different plugins, so aireg reads .claude-plugin/marketplace.json alone: "deploy-kit" is in only one.',
    );
  }, 60_000);

  test("skips what it cannot install, and says why", async ({ aireg, tmp }) => {
    const root = await marketplace(join(tmp, "mkt"))
      .json(".claude-plugin/marketplace.json", {
        name: "acme-tools",
        owner: { name: "Acme" },
        plugins: [
          { name: "docs-kit", source: "./plugins/docs-kit", strict: false, skills: ["./extra"] },
          { name: "far", source: { source: "github", repo: "example/far" } },
          { name: "made", source: { source: "command", command: "make-plugin" } },
          { name: "deploy-kit", source: "./plugins/deploy-kit" },
        ],
      })
      .write();
    await init(aireg, "claude");
    const shown = await aireg(["registry", "show", root]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).toContain(
      'Skipped "docs-kit": its entry is `strict: false`, but both it and plugins/docs-kit/.claude-plugin/plugin.json name components.',
    );
    expect(shown.stderr).toContain(
      'Skipped "far": aireg fetches its github source only for a marketplace it reads with git.',
    );
    expect(shown.stderr).toContain('Skipped "made": its command source is not one aireg reads.');
  }, 60_000);

  test("refuses a broken marketplace rather than reading the skills beside it", async ({
    aireg,
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "broken"))
      .file(".claude-plugin/marketplace.json", "{ not json")
      .skill("skills/x")
      .write();
    await init(aireg, "claude");
    const added = await aireg(["add", root, "--all"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(".claude-plugin/marketplace.json is not valid JSON.");
  }, 60_000);
});

describe("-s on a plugin", () => {
  test("installs that one skill on its own, outside the plugin", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const added = await aireg(["add", "acme-tools/docs-kit", "-s", "pdf"]);
    expect(added.code, added.stderr).toBe(0);
    const lock = parse(await read(lockPath(project))) as {
      artifacts: Record<string, { kind: string; namespace?: string }>;
    };
    expect(lock.artifacts).toEqual({
      pdf: expect.objectContaining({ kind: "skill", namespace: "docs-kit" }),
    });
    expect(existsSync(join(project, ".claude", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "docs-kit"))).toBe(false);
  }, 60_000);

  test("lists the plugin's skills for a name it does not hold", async ({ aireg, tmp }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const added = await aireg(["add", "acme-tools/docs-kit", "-s", "nope"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain('acme-tools publishes nothing named "nope".');
    expect(added.stderr).toContain("Use docs-kit, pdf or xlsx.");
  }, 60_000);

  test("adds a plugin of many skills by its name without asking, as one artifact", async ({
    aireg,
    project,
    tmp,
  }) => {
    const kit = marketplace(join(tmp, "mkt"));
    for (let at = 0; at < 11; at += 1) kit.skill(`plugins/docs-kit/skills/tip-${at}`);
    const root = await kit.write();
    await init(aireg, "claude");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const added = await aireg(["add", "acme-tools/docs-kit", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await locked(project)).toEqual(["docs-kit"]);
  }, 60_000);

  test("names the part of a plugin whose name another skill already holds, and keeps it there", async ({
    aireg,
    project,
    tmp,
  }) => {
    const mine = await skillsFolder(join(tmp, "mine")).skill("skills/pdf").write();
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "agents");
    expect((await aireg(["add", mine, "--all"])).code).toBe(0);
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const added = await aireg(["add", "acme-tools/docs-kit", "-y"]);
    expect(added.stdout).toContain("docs-kit, because pdf is taken by mine/pdf");
    // The skill installed first keeps its name run after run.
    const again = await aireg(["install"]);
    expect(again.stdout).not.toContain("renamed");
    expect(again.stdout).toContain("docs-kit, because pdf is taken by mine/pdf");
    expect(await locked(project)).toEqual(["docs-kit", "pdf"]);
  }, 60_000);

  test("refuses a name that is both a plugin and a skill, naming how to take each", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt"))
      .skill("plugins/docs-kit/skills/docs-kit")
      .write();
    await init(aireg, "claude");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const refused = await aireg(["add", "acme-tools", "-s", "docs-kit"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      '"docs-kit" names both the plugin docs-kit and the skill docs-kit/skill/docs-kit.',
    );
    expect(refused.stderr).toContain(
      "Add the whole plugin with `aireg add acme-tools/docs-kit`, or only the skill with `-s docs-kit/skill/docs-kit`.",
    );
    const skill = await aireg(["add", "acme-tools", "-s", "docs-kit/skill/docs-kit"]);
    expect(skill.code, skill.stderr).toBe(0);
    expect(await locked(project)).toEqual(["docs-kit"]);
    expect(existsSync(join(project, ".claude", "skills", "docs-kit", "SKILL.md"))).toBe(true);
  }, 60_000);

  test("leaves a whole-plugin install as it was", async ({ aireg, project, tmp }) => {
    const root = await marketplace(join(tmp, "mkt")).write();
    await init(aireg, "claude");
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    expect((await aireg(["add", "acme-tools/docs-kit"])).code).toBe(0);
    expect(await locked(project)).toEqual(["docs-kit"]);
  }, 60_000);
});

describe("a folder that is one plugin", () => {
  for (const [manifest, body] of [
    [".claude-plugin/plugin.json", { name: "hello" }],
    [".codex-plugin/plugin.json", { name: "hello" }],
    [
      "plugin.json",
      { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "hello" },
    ],
  ] as const) {
    test(`installs by its ${manifest}, and registers it with Codex in your user scope`, async ({
      aireg,
      home,
      tmp,
    }) => {
      const root = await skillsFolder(join(tmp, "single"))
        .json(manifest, body)
        .skill("skills/greet")
        .write();
      const added = await aireg(
        ["add", root, "--all", "-g", "--for", "codex", "--no-auto-update"],
        {
          cwd: tmp,
        },
      );
      expect(added.code, added.stderr).toBe(0);
      const config = await read(join(home.dir, ".codex", "config.toml"));
      expect(config).toContain('[plugins."hello@single"]');
      expect(
        existsSync(join(home.dir, ".codex", "plugins", "cache", "single", "hello", "local")),
      ).toBe(true);
    }, 60_000);
  }
});
