import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let aireg: Aireg;
/** The repository that makes the agent, with its registry folder inside it. */
let maker: string;
/** Another project, which installs from that registry folder. */
let project: string;

const SKILLS = ["lint", "review", "style"];

const MANIFEST = `exports:
  - skills/review
  - skills/style
  - path: agents/helper.md
    depends_on: [./skills]
publish:
  to: ./registry/team
`;

const envelope = async (kind: string, name: string) =>
  JSON.parse(
    await readFile(
      join(maker, "registry", "artifacts", "team", kind, name, "0.1.0", "artifact.json"),
      "utf8",
    ),
  );

test.beforeAll(async ({ aireg: run, tmp, project: dir, git }) => {
  [aireg, maker, project] = [run, join(tmp, "maker"), dir];
  await git.init(maker);
  for (const name of SKILLS) {
    await mkdir(join(maker, "skills", name), { recursive: true });
    await writeFile(join(maker, "skills", name, "SKILL.md"), skillBody(name, `The ${name} skill.`));
  }
  await writeFile(join(maker, "skills", "README.md"), "# Skills\n");
  await mkdir(join(maker, "agents"), { recursive: true });
  await writeFile(
    join(maker, "agents", "helper.md"),
    "---\nname: helper\ndescription: Helps with pull requests.\n---\nHelp.\n",
  );
  await writeManifestIn(maker, MANIFEST);
  await git(maker, "add", ".");
  await git(maker, "commit", "-qm", "helper");
  const made = await aireg(["registry", "init", "registry", "--name", "maker", "-y"], {
    cwd: maker,
  });
  expect(made.code, made.stderr).toBe(0);
}, 60_000);

describe("an export depending on a folder", () => {
  test("publishes every skill in it, the one with no entry too, and an edge to each", async () => {
    const shown = await aireg(["publish", "--dry-run", "--json"], { cwd: maker });
    expect(shown.code, shown.stderr).toBe(0);
    const { artifacts } = JSON.parse(shown.stdout).data as {
      artifacts: { name: string; kind: string }[];
    };
    expect(artifacts.map(({ name, kind }) => `${kind} ${name}`)).toEqual([
      "skill review",
      "skill style",
      "skill lint",
      "agent helper",
    ]);
    const sent = await aireg(["publish", "-y"], { cwd: maker });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toContain(
      "Skipped skills/README.md, which has no name and description in its front matter, so it is no agent.",
    );
    expect(sent.stdout).toMatch(/add {5}team\/skill\/lint {2}0\.1\.0\n/);
    expect((await envelope("agent", "helper")).relationships).toEqual(
      SKILLS.map((name) => ({
        rel_type: "depends_on",
        to: `team/skill/${name}@0.1.0`,
      })),
    );
    expect((await envelope("skill", "lint")).relationships).toBeUndefined();
    const valid = await aireg(["registry", "validate"], { cwd: join(maker, "registry") });
    expect(valid.code, valid.stdout + valid.stderr).toBe(0);
  });

  test("installs the agent into another project with the three skills", async () => {
    await mkdir(join(project, ".claude"), { recursive: true });
    expect((await aireg(["init", "-y"])).code).toBe(0);
    const declared = await aireg(["registry", "add", join(maker, "registry"), "--as", "maker"]);
    expect(declared.code, declared.stderr).toBe(0);
    const added = await aireg(["add", "maker/team/agent/helper", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    for (const name of SKILLS) {
      expect(
        await readFile(join(project, ".claude", "skills", name, "SKILL.md"), "utf8"),
        name,
      ).toBe(await readFile(join(maker, "skills", name, "SKILL.md"), "utf8"));
    }
    expect(await readFile(join(project, ".claude", "agents", "helper.md"), "utf8")).toContain(
      "Help.",
    );
  }, 60_000);
});
