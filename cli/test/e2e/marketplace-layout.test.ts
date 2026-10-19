import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { marketplace, skillsFolder } from "#test/kit/builders/layouts.ts";
import { type Aireg, test } from "#test/kit/fixtures.ts";
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
    expect(await locked(project)).toEqual(["deploy-kit", "docs-kit"]);
    expect(await read(manifestPath(project))).toContain("layout: marketplace");
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
    expect(shown.stderr).toContain('Skipped "far": its github source is not one aireg reads.');
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
    expect(added.stderr).toContain("Use pdf or xlsx.");
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
