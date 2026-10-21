import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { fromPath } from "./work.ts";

describe("fromPath", () => {
  test("reads a skill, a folder agent and an agent file from what each entry file says", async ({
    tmp,
  }) => {
    await mkdir(join(tmp, "review"));
    await writeFile(
      join(tmp, "review", "SKILL.md"),
      "---\nname: review\ndescription: Reviews.\n---\n",
    );
    await mkdir(join(tmp, "claw"));
    await writeFile(join(tmp, "claw", "AGENT.md"), "---\nname: optimus\ndescription: Runs.\n---\n");
    await writeFile(join(tmp, "triage.md"), "---\nname: triage\ndescription: Sorts.\n---\n");

    expect(await fromPath(join(tmp, "review"))).toMatchObject({ kind: "skill", name: "review" });
    expect(await fromPath(join(tmp, "review", "SKILL.md"))).toMatchObject({
      kind: "skill",
      path: join(tmp, "review"),
    });
    expect(await fromPath(join(tmp, "claw"))).toMatchObject({ kind: "agent", name: "optimus" });
    expect(await fromPath(join(tmp, "triage.md"))).toMatchObject({
      kind: "agent",
      name: "triage",
      path: join(tmp, "triage.md"),
    });
  });

  test("calls a path with nothing at it no artifact, rather than failing to read it", async ({
    tmp,
  }) => {
    await expect(fromPath(join(tmp, "gone"))).rejects.toMatchObject({
      message: `${join(tmp, "gone")} is not an artifact.`,
    });
    await expect(fromPath(join(tmp, "gone.md"))).rejects.toMatchObject({
      message: `${join(tmp, "gone.md")} is not an artifact.`,
    });
  });

  test("refuses a folder holding both entry files", async ({ tmp }) => {
    await mkdir(join(tmp, "both"));
    await writeFile(join(tmp, "both", "SKILL.md"), "---\nname: both\ndescription: One.\n---\n");
    await writeFile(join(tmp, "both", "AGENT.md"), "---\nname: both\ndescription: Two.\n---\n");
    await expect(fromPath(join(tmp, "both"))).rejects.toThrow("holds both SKILL.md and AGENT.md");
  });
});
