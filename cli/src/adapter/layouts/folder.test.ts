import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillFile, skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { contentDigest } from "../spec/canonical.ts";
import { folderLayout } from "./folder.ts";
import { openTree } from "./tree.ts";

const context = { namespace: "kit", rootName: "kit" };

async function read(root: string) {
  return folderLayout.enumerate(await openTree(root), context);
}

const listed = (found: Awaited<ReturnType<typeof read>>) =>
  found.artifacts.map((artifact) => [
    artifact.kind,
    artifact.group,
    artifact.envelope.metadata.name,
    artifact.id,
  ]);

describe("the folder layout", () => {
  test("finds skills in every place a repository keeps them, and agents", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "kit"))
      .skill("pdf")
      .skill("skills/xlsx")
      .skill("skills/frontend/react-tips")
      .skill(".claude/skills/release")
      .skill(".agents/skills/notes")
      .agent("agents/reviewer.md")
      .agent(".claude/agents/triage.md")
      .file("agents/README.md", "# Agents\n")
      .skill("a/b/c/too-deep")
      .skill("node_modules/dep/skill")
      .skill(".hidden/skill")
      .write();
    const found = await read(root);
    expect(listed(found)).toEqual([
      ["skill", "kit", "notes", ".agents/skills/notes"],
      ["agent", "kit", "triage", ".claude/agents/triage.md"],
      ["skill", "kit", "release", ".claude/skills/release"],
      ["agent", "kit", "reviewer", "agents/reviewer.md"],
      ["skill", "kit", "pdf", "pdf"],
      ["skill", "frontend", "react-tips", "skills/frontend/react-tips"],
      ["skill", "kit", "xlsx", "skills/xlsx"],
    ]);
    expect(found.warnings).toEqual([]);
    expect(await folderLayout.match(await openTree(root))).toBe("yes");
  });

  test("never looks inside a skill, and reads one at the root as the whole source", async ({
    tmp,
  }) => {
    const nested = await skillsFolder(join(tmp, "nested"))
      .skill("pdf")
      .skill("pdf/examples/inner")
      .write();
    expect(listed(await read(nested))).toEqual([["skill", "kit", "pdf", "pdf"]]);
    const found = await read(nested);
    expect(found.artifacts[0]?.envelope.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "examples/inner/SKILL.md",
    ]);

    const whole = await skillsFolder(join(tmp, "whole"))
      .file("SKILL.md", skillFile("kit"))
      .skill("skills/other")
      .agent("agents/a.md")
      .write();
    const one = await read(whole);
    expect(listed(one)).toEqual([["skill", "kit", "kit", "."]]);
    expect(one.artifacts[0]?.files.map((file) => file.locator)).toEqual([
      "SKILL.md",
      "agents/a.md",
      "skills/other/SKILL.md",
    ]);
  });

  test("keeps the first of two that share a name, and says so", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "kit"))
      .skill("pdf")
      .skill("skills/pdf")
      .skill("skills/Bad_Name")
      .write();
    const found = await read(root);
    expect(listed(found)).toEqual([["skill", "kit", "pdf", "pdf"]]);
    expect(found.warnings).toEqual([
      'Skipped skills/Bad_Name: "Bad_Name" is not a name aireg installs, which takes lowercase letters, digits and hyphens.',
      'Skipped skills/pdf: pdf is also a skill named "pdf".',
    ]);
  });

  test("names it after its folder, and warns when its front matter says otherwise", async ({
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "kit"))
      .skill("skills/pdf", { name: "pdf-forms" })
      .write();
    const found = await read(root);
    expect(found.artifacts[0]?.envelope.metadata.name).toBe("pdf");
    expect(found.warnings).toEqual([
      'skills/pdf/SKILL.md names the skill "pdf-forms", but aireg installs it as "pdf", the name of its folder.',
    ]);
  });

  test("skips a link, inside a skill and among skills, and never reads through it", async ({
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "kit"))
      .skill("skills/pdf")
      .link("skills/pdf/secrets", "/etc")
      .link("skills/evil", "/etc")
      .write();
    const found = await read(root);
    expect(found.artifacts[0]?.envelope.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(found.warnings).toEqual([
      "Skipped skills/evil, which is a symlink.",
      "Skipped skills/pdf/secrets, which is a symlink.",
    ]);
  });

  test("never takes a version from front matter", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "kit"))
      .file(
        "skills/pdf/SKILL.md",
        "---\nname: pdf\ndescription: P.\nmetadata:\n  version: 2.1.0\n---\n",
      )
      .write();
    const [artifact] = (await read(root)).artifacts;
    expect(artifact?.version).toBeUndefined();
    expect(artifact?.envelope.metadata).not.toHaveProperty("version");
  });

  test("gives the same bytes the same digest, wherever and under whatever namespace", async ({
    tmp,
  }) => {
    const write = (dir: string, at: string) =>
      skillsFolder(join(tmp, dir))
        .skill(at, { description: "Fill PDF forms.", body: "Fill them.\n" })
        .file(`${at}/scripts/fill.sh`, "#!/bin/sh\necho fill\n", true)
        .write();
    const one = (await read(await write("one", "skills/pdf"))).artifacts[0];
    const two = (await openTree(await write("two", "skills/team/pdf"))).root;
    const other = (
      await folderLayout.enumerate(await openTree(two), { namespace: "x", rootName: "x" })
    ).artifacts[0];
    expect(one?.group).toBe("kit");
    expect(other?.group).toBe("team");
    // Golden: a change here changes the identity of every skill read from a folder.
    expect(contentDigest(one?.envelope as never)).toBe(GOLDEN);
    expect(contentDigest(other?.envelope as never)).toBe(GOLDEN);
    expect(one?.files.find((file) => file.path === "scripts/fill.sh")?.executable).toBe(
      process.platform !== "win32",
    );
  });

  test("does not match a source with neither skills nor agents", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "kit")).file("README.md", "# Kit\n").write();
    expect(await folderLayout.match(await openTree(root))).toBe("no");
  });
});

/** Computed by hand from RFC 8785 over the envelope, independently of this code. */
const GOLDEN = "sha256:53ca33f6d7da12195ef21f4355df488f676b08d49caf9e40c5d9811060160a49";
