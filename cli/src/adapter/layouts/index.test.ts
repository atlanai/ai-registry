import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { detectLayout, openLayoutRoot } from "./index.ts";

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
