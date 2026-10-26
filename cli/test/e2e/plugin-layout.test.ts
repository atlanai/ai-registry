import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { marketplace, skillsFolder } from "#test/kit/builders/layouts.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";
import { projectTemplate } from "#test/kit/template.ts";

const test = base
  .extend("initialised", { scope: "file" }, ({ fileTmp }) =>
    projectTemplate(join(fileTmp, "initialised"), [["init", "--for", "claude-code"]]),
  )
  /** A project for Claude Code that declares the stock marketplace, which no test changes. */
  .extend("declared", { scope: "file" }, async ({ fileTmp }) => {
    const root = await marketplace(join(fileTmp, "mkt")).write();
    return projectTemplate(join(fileTmp, "declared"), [
      ["init", "--for", "claude-code"],
      ["registry", "add", root],
    ]);
  });

const read = (path: string) => readFile(path, "utf8");

const locked = async (project: string) =>
  Object.keys(
    (parse(await read(lockPath(project))) as { artifacts: Record<string, unknown> }).artifacts,
  ).sort();

describe("-s on a plugin", () => {
  test("installs that one skill on its own, outside the plugin", async ({
    aireg,
    declared,
    project,
  }) => {
    await declared(project);
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
  });

  test("lists the plugin's skills for a name it does not hold", async ({
    aireg,
    declared,
    project,
  }) => {
    await declared(project);
    const added = await aireg(["add", "acme-tools/docs-kit", "-s", "nope"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain('acme-tools publishes nothing named "nope".');
    expect(added.stderr).toContain("Use docs-kit, pdf or xlsx.");
  });

  test("adds a plugin of many skills by its name without asking, as one artifact", async ({
    aireg,
    initialised,
    project,
    tmp,
  }) => {
    const kit = marketplace(join(tmp, "mkt"));
    for (let at = 0; at < 11; at += 1) kit.skill(`plugins/docs-kit/skills/tip-${at}`);
    const root = await kit.write();
    await initialised(project);
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const added = await aireg(["add", "acme-tools/docs-kit", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await locked(project)).toEqual(["docs-kit"]);
  });

  test("names the part of a plugin whose name another skill already holds, and keeps it there", async ({
    aireg,
    project,
    tmp,
  }) => {
    const mine = await skillsFolder(join(tmp, "mine")).skill("skills/pdf").write();
    const root = await marketplace(join(tmp, "mkt")).write();
    expect((await aireg(["init", "--for", "universal"])).code).toBe(0);
    expect((await aireg(["add", mine, "--all"])).code).toBe(0);
    expect((await aireg(["registry", "add", root])).code).toBe(0);
    const added = await aireg(["add", "acme-tools/docs-kit", "-y"]);
    expect(added.stdout).toContain("docs-kit, because pdf is taken by mine/pdf");
    // The skill installed first keeps its name run after run.
    const again = await aireg(["install"]);
    expect(again.stdout).not.toContain("renamed");
    expect(again.stdout).toContain("docs-kit, because pdf is taken by mine/pdf");
    expect(await locked(project)).toEqual(["docs-kit", "pdf"]);
  });

  test("refuses a name that is both a plugin and a skill, naming how to take each", async ({
    aireg,
    initialised,
    project,
    tmp,
  }) => {
    const root = await marketplace(join(tmp, "mkt"))
      .skill("plugins/docs-kit/skills/docs-kit")
      .write();
    await initialised(project);
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
  });
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
    });
  }
});
