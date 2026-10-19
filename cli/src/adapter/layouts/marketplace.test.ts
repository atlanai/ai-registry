import { join } from "node:path";
import { describe, expect } from "vitest";
import { marketplace, skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { marketplaceLayout } from "./marketplace.ts";
import { openTree } from "./tree.ts";

const context = { namespace: "mkt", rootName: "mkt" };

async function read(root: string) {
  return marketplaceLayout.enumerate(await openTree(root), context);
}

const listed = (found: Awaited<ReturnType<typeof read>>) =>
  found.artifacts.map((item) => [item.kind, item.group, item.envelope.metadata.name, item.id]);

const specOf = (found: Awaited<ReturnType<typeof read>>, name: string) =>
  found.artifacts.find((item) => item.kind === "plugin" && item.envelope.metadata.name === name)
    ?.envelope.spec;

const entries = (plugins: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "acme-tools",
  owner: { name: "Acme" },
  plugins,
  ...extra,
});

describe("the marketplace layout", () => {
  test("lists each plugin whole, then its skills and agents under its name", async ({ tmp }) => {
    const root = await marketplace(join(tmp, "mkt"))
      .agent("plugins/docs-kit/agents/editor.md")
      .write();
    const found = await read(root);
    expect(found.name).toBe("acme-tools");
    expect(listed(found)).toEqual([
      ["plugin", undefined, "docs-kit", "plugins/docs-kit"],
      ["skill", "docs-kit", "pdf", "plugins/docs-kit/skills/pdf"],
      ["skill", "docs-kit", "xlsx", "plugins/docs-kit/skills/xlsx"],
      ["agent", "docs-kit", "editor", "plugins/docs-kit/agents/editor.md"],
      ["plugin", undefined, "deploy-kit", "plugins/deploy-kit"],
      ["skill", "deploy-kit", "ship", "plugins/deploy-kit/skills/ship"],
    ]);
    expect(specOf(found, "docs-kit")?.commands).toEqual([
      { name: "summarize", path: "commands/summarize.md" },
    ]);
  });

  test("resolves bare names under pluginRoot, and a Codex local source", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(
        ".claude-plugin/marketplace.json",
        entries([{ name: "a", source: "a" }], { metadata: { pluginRoot: "./plugins" } }),
      )
      .skill("plugins/a/skills/one")
      .write();
    expect(listed(await read(root)).map(([, , name]) => name)).toEqual(["a", "one"]);

    const codex = await skillsFolder(join(tmp, "codex"))
      .json(".agents/plugins/marketplace.json", {
        name: "acme-tools",
        plugins: [{ name: "b", source: { source: "local", path: "./b" } }],
      })
      .skill("b/skills/two")
      .write();
    expect(listed(await read(codex)).map(([, , name]) => name)).toEqual(["b", "two"]);
  });

  test("takes only the skills a root-source entry names", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(
        ".claude-plugin/marketplace.json",
        entries([{ name: "kit", source: "./", skills: ["./skills/a"] }]),
      )
      .skill("skills/a")
      .skill("skills/b")
      .write();
    const found = await read(root);
    expect(listed(found)).toEqual([
      ["plugin", undefined, "kit", "."],
      ["skill", "kit", "a", "skills/a"],
    ]);
    expect(found.artifacts[0]?.envelope.files.map((file) => file.path)).toEqual([
      "skills/a/SKILL.md",
    ]);
  });

  test("appends an entry's components to the plugin's own manifest, strict by default", async ({
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(
        ".claude-plugin/marketplace.json",
        entries([{ name: "kit", source: "./kit", skills: ["./extra"] }]),
      )
      .json("kit/.claude-plugin/plugin.json", { name: "kit", skills: ["./more"] })
      .skill("kit/extra/a")
      .skill("kit/more/b")
      .skill("kit/skills/c")
      .write();
    const found = await read(root);
    expect(listed(found).map(([, , name]) => name)).toEqual(["kit", "a", "b", "c"]);
    expect(JSON.parse(specOf(found, "kit")?.manifest as string)).toEqual({
      name: "kit",
      skills: ["./more", "./extra"],
    });
  });

  test("makes a plugin of one skill from a SKILL.md at its root", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(".claude-plugin/marketplace.json", entries([{ name: "solo", source: "./solo" }]))
      .file("solo/SKILL.md", "---\nname: solo\ndescription: Alone.\n---\nAlone.\n")
      .write();
    expect(listed(await read(root))).toEqual([
      ["plugin", undefined, "solo", "solo"],
      ["skill", "solo", "solo", "solo"],
    ]);
  });

  test("reads commands a manifest maps by name", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(
        ".claude-plugin/marketplace.json",
        entries([
          { name: "kit", source: "./kit", commands: { deploy: { source: "./ops/deploy.md" } } },
        ]),
      )
      .file("kit/ops/deploy.md", "Deploy.\n")
      .file("kit/commands/ignored.md", "Not read, since the map replaces the folder.\n")
      .write();
    expect(specOf(await read(root), "kit")?.commands).toEqual([
      { name: "deploy", path: "ops/deploy.md" },
    ]);
  });

  test("refuses a Claude Code marketplace with no owner", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(".claude-plugin/marketplace.json", { name: "acme-tools", plugins: [] })
      .write();
    await expect(read(root)).rejects.toThrow(
      ".claude-plugin/marketplace.json needs `name`, `owner.name` and `plugins`.",
    );
  });

  test("never reads a source that leaves the marketplace", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(".claude-plugin/marketplace.json", entries([{ name: "out", source: "./../elsewhere" }]))
      .write();
    expect((await read(root)).warnings).toEqual([
      'Skipped "out": its source, "./../elsewhere", is not a folder inside the marketplace.',
    ]);
  });
});
