import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { assemble } from "./assemble.ts";

let root: string;
const projection = () => join(root, "projection");
const content = () => join(root, "content");

test.beforeEach(async ({ tmp }) => {
  root = tmp;
});
async function publish(kindDir: string, leaf: string): Promise<void> {
  const dir = join(content(), kindDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, leaf), "body\n");
}

// One directory serves every harness only if every kind the namespace publishes is linked.
describe("assembling a projection", () => {
  test("links every kind directory the namespace publishes", async () => {
    await publish("skills", "lint");
    await publish("agents", "rev.md");

    await assemble(projection(), content(), ["claude"]);

    const inside = (await readdir(projection())).sort();
    expect(inside).toContain("skills");
    expect(inside).toContain("agents");
    expect(await readFile(join(projection(), "agents", "rev.md"), "utf8")).toBe("body\n");
  });

  test("picks up a kind that arrived after the first assemble", async () => {
    await publish("skills", "lint");
    await assemble(projection(), content(), ["claude"]);
    expect(await readdir(projection())).not.toContain("agents");

    // What a run does: the rest of the namespace clones, then it rebuilds.
    await publish("agents", "rev.md");
    await assemble(projection(), content(), ["claude"]);
    expect(await readdir(projection())).toContain("agents");
  });

  test("stops linking a kind the namespace no longer publishes", async () => {
    await publish("skills", "lint");
    await publish("agents", "rev.md");
    await assemble(projection(), content(), ["claude"]);

    await rm(join(content(), "agents"), { recursive: true, force: true });
    await assemble(projection(), content(), ["claude"]);
    expect(await readdir(projection())).not.toContain("agents");
  });

  test("copies a file on Windows, where a junction reaches only a folder", async () => {
    await publish("skills", "lint");
    await writeFile(join(content(), ".mcp.json"), '{"mcpServers":{}}\n');
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await assemble(projection(), content(), ["claude"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const mcp = join(projection(), ".mcp.json");
    expect((await lstat(mcp)).isSymbolicLink()).toBe(false);
    expect(await readFile(mcp, "utf8")).toBe('{"mcpServers":{}}\n');
  });

  test("writes one manifest per harness that reads it, and a portable root", async () => {
    await publish("skills", "lint");
    await assemble(projection(), content(), ["claude", "codex"]);

    const inside = await readdir(projection());
    expect(inside).toContain(".claude-plugin");
    expect(inside).toContain(".codex-plugin");
    expect(inside).toContain("plugin.json");
    const manifest = JSON.parse(
      await readFile(join(projection(), ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("projection");
    expect(JSON.parse(await readFile(join(projection(), "plugin.json"), "utf8"))).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "projection",
      description: "Artifacts the projection namespace publishes.",
      interface: {
        displayName: "projection",
        shortDescription: "Artifacts the projection namespace publishes.",
      },
      skills: "./skills/",
    });
  });

  // Two registries' `engineering` namespaces assemble into differently named
  // projections, and a harness that keys plugins by name must see two names.
  test("names the plugin after its projection, not the namespace it holds", async () => {
    await publish("skills", "lint");
    const renamed = join(root, "kit-engineering");
    await assemble(renamed, content(), ["claude"]);

    const manifest = JSON.parse(
      await readFile(join(renamed, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("kit-engineering");
  });
});
