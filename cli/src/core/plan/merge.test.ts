import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { resolveTargets } from "#core/target/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { mergeNamespaces } from "./merge.ts";

let root: string;
const merged = () => join(root, "aireg", "acme");
const namespaces = () => join(merged(), "namespaces");
const claude = () =>
  resolveTargets()["claude-code"] as NonNullable<ReturnType<typeof resolveTargets>[string]>;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
});

/** A namespace's projection, linked where the engine links it. */
async function namespace(name: string, parts: Record<string, string[]>): Promise<void> {
  const projection = join(root, "projections", name);
  for (const [part, leaves] of Object.entries(parts)) {
    for (const leaf of leaves) {
      const at = join(projection, part, leaf);
      if (leaf.endsWith(".md")) {
        await mkdir(join(projection, part), { recursive: true });
        await writeFile(at, `${name}\n`);
      } else {
        await mkdir(at, { recursive: true });
        await writeFile(join(at, "SKILL.md"), `${name}\n`);
      }
    }
  }
  await mkdir(namespaces(), { recursive: true });
  await symlink(projection, join(namespaces(), name));
}

const merge = () => mergeNamespaces(merged(), namespaces(), claude(), "acme", join(root, "aireg"));

describe("merging a registry's namespaces into one plugin", () => {
  test("links each part under its own name, and names the registry in the manifest", async () => {
    await namespace("eng", { skills: ["lint"], agents: ["planner.md"] });
    await namespace("ops", { skills: ["audit"] });

    await merge();

    expect(await readdir(join(merged(), "skills"))).toEqual(["audit", "lint"]);
    expect((await lstat(join(merged(), "skills", "lint"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(merged(), "agents", "planner.md"), "utf8")).toBe("eng\n");
    const manifest = await readFile(join(merged(), ".claude-plugin", "plugin.json"), "utf8");
    expect(JSON.parse(manifest)).toEqual({
      name: "acme",
      description: "Artifacts the acme registry publishes.",
    });
  });

  test("prefixes an entry two namespaces hold with each one's name", async () => {
    await namespace("eng", { skills: ["deploy"], agents: ["rev.md"] });
    await namespace("ops", { skills: ["deploy", "audit"], agents: ["rev.md"] });

    await merge();

    expect(await readdir(join(merged(), "skills"))).toEqual(["audit", "eng-deploy", "ops-deploy"]);
    expect(await readdir(join(merged(), "agents"))).toEqual(["eng-rev.md", "ops-rev.md"]);
    expect(await readFile(join(merged(), "skills", "ops-deploy", "SKILL.md"), "utf8")).toBe(
      "ops\n",
    );
  });

  test("keeps every part folder, empty or not, for a target that links only those it saw", async () => {
    await namespace("eng", { skills: ["lint"] });

    await merge();

    expect((await readdir(merged())).sort()).toEqual([
      ".claude-plugin",
      "agents",
      "commands",
      "namespaces",
      "skills",
    ]);
  });

  test("drops what a namespace no longer holds, and anything else in a part folder", async () => {
    await namespace("eng", { skills: ["lint", "old"] });
    await merge();
    await writeFile(join(merged(), "skills", "stray"), "not ours\n");
    await namespace("ops", { skills: ["audit"] });
    await rm(join(root, "projections", "eng", "skills", "old"), {
      recursive: true,
    });

    await merge();

    expect(await readdir(join(merged(), "skills"))).toEqual(["audit", "lint"]);
  });

  test("removes the plugin once no namespace is left", async () => {
    await namespace("eng", { skills: ["lint"] });
    await merge();
    await rm(namespaces(), { recursive: true });

    await merge();

    expect(await readdir(join(root, "aireg")).catch(() => [])).toEqual([]);
  });
});
