import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import type { Want } from "../contract.ts";
import type { RemotePlugin } from "./model.ts";
import { detectLayout, openLayoutRoot } from "./open.ts";

const context = { namespace: "kit", rootName: "kit" };

describe("detectLayout", () => {
  test("reads a registry first, then a folder of skills", async ({ tmp }) => {
    const reg = await registry(join(tmp, "reg")).skill("acme/lint@1.0.0").write();
    // A registry with skills lying about beside it is still a registry.
    await skillsFolder(reg).skill("skills/stray").write();
    expect(await detectLayout(reg)).toBe("registry");
    expect(await detectLayout(await skillsFolder(join(tmp, "kit")).skill("pdf").write())).toBe(
      "folder",
    );
  });

  test("refuses a broken registry.json rather than reading what sits beside it", async ({
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "kit")).skill("pdf").write();
    await writeFile(join(root, "registry.json"), "{ not json");
    await expect(detectLayout(root)).rejects.toThrow("registry.json is not valid JSON.");
    expect(await detectLayout(root, "folder")).toBe("folder");
  });

  test("says what it looked for in a source that holds none of it", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "empty")).file("README.md", "# Empty\n").write();
    await expect(detectLayout(root)).rejects.toThrow(
      "This source holds nothing aireg reads: no registry.json, marketplace.json, plugin.json, SKILL.md or agents/*.md.",
    );
  });
});

describe("openLayoutRoot", () => {
  test("narrows a folder of skills to what is wanted, and reads only that", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "kit")).skill("pdf").skill("skills/xlsx").write();
    const files = openLayoutRoot();
    const resolution = await files.resolve(root, [{ name: "pdf" }], { context });
    expect(resolution.layout).toBe("folder");
    expect(resolution.registry).toEqual({ name: "kit" });
    const pdf = resolution.artifacts[0]!;
    expect(resolution.artifacts.map((item) => item.id)).toEqual(["pdf"]);
    expect(await files.localRoot(pdf)).toBe(join(root, "pdf"));
    const bytes = await files.fetch(pdf, pdf.files[0]!);
    expect(new TextDecoder().decode(bytes)).toContain("name: pdf");
  });

  test("fetches only the remote plugins a resolve asks for, and every one when it asks for all", async ({
    tmp,
  }) => {
    const names = ["far", "near", "wide"];
    const root = await skillsFolder(join(tmp, "mkt"))
      .json(".claude-plugin/marketplace.json", {
        name: "acme-tools",
        owner: { name: "Acme" },
        plugins: names.map((name) => ({
          name,
          source: { source: "github", repo: `acme/${name}` },
        })),
      })
      .write();
    for (const name of names) {
      await skillsFolder(join(tmp, name)).skill("skills/tip", { name: "tip" }).write();
    }
    const fetched: string[] = [];
    const fetch = async (plugin: RemotePlugin) => {
      fetched.push(plugin.name);
      return { root: join(tmp, plugin.name), revision: "0".repeat(40), version: undefined };
    };
    const files = openLayoutRoot();
    const read = async (wanted: Want[], all = false) => {
      fetched.length = 0;
      const resolution = await files.resolve(root, wanted, { all, context: { ...context, fetch } });
      return resolution.artifacts.map((item) => item.id);
    };

    expect(await read([{ name: "near" }])).toEqual(["@remote/near", "@remote/near/skills/tip"]);
    expect(fetched).toEqual(["near"]);
    // A skill of a plugin is asked for by its plugin's name, as its namespace.
    expect(await read([{ name: "tip", namespace: "wide", kind: "skill" }])).toEqual([
      "@remote/wide/skills/tip",
    ]);
    expect(fetched).toEqual(["wide"]);
    // A name no entry has, such as one a plugin goes by elsewhere, reads them all to find it.
    expect(await read([{ name: "tip", kind: "skill" }])).toHaveLength(3);
    expect(fetched).toEqual(names);
    await read([], true);
    expect(fetched).toEqual(names);
  });

  test("reads a registry as the file spec reader does", async ({ tmp }) => {
    const reg = await registry(join(tmp, "reg")).skill("acme/lint@1.0.0").write();
    const resolution = await openLayoutRoot().resolve(reg, [], { context });
    expect(resolution.layout).toBe("registry");
    expect(resolution.artifacts.map((item) => item.id)).toEqual([
      "artifacts/acme/skill/lint/1.0.0",
    ]);
  });

  test("forced to a folder, reads the skills beside a registry.json", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "kit")).skill("pdf").write();
    await writeFile(join(root, "registry.json"), "{ not json");
    const resolution = await openLayoutRoot().resolve(root, [], { context, layout: "folder" });
    expect(resolution.artifacts.map((item) => item.id)).toEqual(["pdf"]);
  });
});
