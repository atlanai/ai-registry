import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { fileTest as test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";

test("a skill with no place in the registry fails alone, and the rest of the batch publishes", async ({
  aireg,
  git,
  tmp,
  project,
}) => {
  const team = join(tmp, "team");
  await registry(team, { name: "team", slug: "team" })
    .skill("eng/tool@0.1.0", { body: "Version one.\n" })
    .write();
  await git.init(project);
  expect((await aireg(["registry", "add", team, "--as", "team"])).code).toBe(0);
  expect((await aireg(["add", "team/eng/tool", "-y"])).code).toBe(0);
  await appendFile(join(project, ".claude", "skills", "tool", "SKILL.md"), "Edited here.\n");
  // New local work, and the account names no namespace to publish it into.
  await mkdir(join(project, ".claude", "skills", "mine"), { recursive: true });
  await writeFile(join(project, ".claude", "skills", "mine", "SKILL.md"), skillBody("mine"));

  const sent = await aireg(["sync", "--publish", "on", "-y"]);
  const output = `${sent.stdout}${sent.stderr}`;
  expect(sent.code, output).toBe(1);
  expect(output).toMatch(/published\s+tool\n/);
  expect(output).toMatch(
    /failed\s+mine\s+mine has no namespace or version, so there is no path in the registry/,
  );
  expect(output).not.toMatch(/failed\s+tool/);
  expect(output).toContain("Checked 2 artifacts: 1 changed and 1 failed.");
  const versions = await readFile(
    join(team, "artifacts", "eng", "skill", "tool", "versions.json"),
    "utf8",
  );
  expect(versions).toContain('"0.1.1"');
});
