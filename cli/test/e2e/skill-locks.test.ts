import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { type Aireg, type Git, test } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";

/** A repository of `pr-review` and `notes`, tagged v1.0.0, then changed past the tag. */
async function skillsRepo(git: Git, root: string): Promise<string> {
  await skillsFolder(root)
    .skill("skills/pr-review", { body: "Review it.\n" })
    .skill("skills/notes", { body: "Take notes.\n" })
    .write();
  await git.init(root);
  await git.commit(root, "one");
  await git.tag(root, "v1.0.0");
  await skillsFolder(root).skill("skills/pr-review", { body: "Review it twice.\n" }).write();
  await git.commit(root, "two");
  return root;
}

async function lockFile(dir: string, repo: string): Promise<string> {
  const path = join(dir, "skills-lock.json");
  const entry = (name: string) => ({
    source: pathToFileURL(repo).href,
    sourceType: "git",
    ref: "v1.0.0",
    skillPath: `skills/${name}/SKILL.md`,
    computedHash: "0".repeat(64),
  });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      skills: {
        "pr-review": entry("pr-review"),
        notes: entry("notes"),
        odd: { source: "x/y", sourceType: "pigeon", skillPath: "skills/odd/SKILL.md" },
      },
    }),
  );
  return path;
}

const init = async (aireg: Aireg) =>
  expect((await aireg(["init", "--for", "claude,agents"])).code).toBe(0);

describe("aireg add --from a skills lock file", () => {
  test("takes over a copy that matches, leaves an edited one, and reports what it cannot read", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const repo = await skillsRepo(git, join(tmp, "skills-repo"));
    const from = await lockFile(tmp, repo);
    await init(aireg);
    // As another installer left them: pr-review as released, notes edited since.
    await skillsFolder(join(project, ".agents", "skills"))
      .skill("pr-review", { body: "Review it.\n" })
      .skill("notes", { body: "My own notes.\n" })
      .write();

    const added = await aireg(["add", "--from", from]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(
      `Skipped "odd" in ${from}: its source type, "pigeon", is not one aireg reads.`,
    );
    expect(added.stderr).toContain(
      "Took over .agents/skills/pr-review, which already held pr-review as aireg installs it.",
    );
    expect(added.stderr).toContain(
      "Did not install notes at .agents/skills/notes: it holds other bytes than aireg installs, so it reads as edited and was left as it is.",
    );
    expect(
      await readFile(join(project, ".agents", "skills", "notes", "SKILL.md"), "utf8"),
    ).toContain("My own notes.");
    const lock = parse(await readFile(lockPath(project), "utf8")) as {
      artifacts: Record<string, { version?: string }>;
    };
    expect(lock.artifacts["pr-review"]?.version).toBe("1.0.0");
    expect(JSON.stringify(lock)).not.toContain("computedHash");

    const before = await readFile(lockPath(project), "utf8");
    const again = await aireg(["add", "--from", from]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).not.toContain("Took over");
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
    expect((await aireg(["install"])).stdout).toContain("Already up to date.");
  }, 60_000);

  test("refuses a file that is not a skills lock, and an address beside it", async ({
    aireg,
    git,
    tmp,
  }) => {
    const repo = await skillsRepo(git, join(tmp, "skills-repo"));
    const broken = join(tmp, "broken.json");
    await writeFile(broken, '{"skills": []}');
    await init(aireg);
    const refused = await aireg(["add", "--from", broken]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("it needs a `version` and a `skills` map.");
    await cp(await lockFile(tmp, repo), join(tmp, "copy.json"));
    const both = await aireg(["add", pathToFileURL(repo).href, "--from", join(tmp, "copy.json")]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("`aireg add --from` takes no address and no -s.");
  }, 60_000);
});
