import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";

// A harness defined by a file in your user scope installs like a built-in one.

let aireg: Aireg;
let project: string;

const AGENT = "---\nname: reviewer\ndescription: Reviews code.\n---\n\nReview the diff.\n";

const TOOL = {
  id: "tool",
  displayName: "Tool",
  roots: { project: ".tool", user: { default: "~/.tool" } },
  trust: { skill: { run: "tool trust", scope: "project" } },
  reload: "Restart Tool to load the change.",
  kinds: {
    plugin: { shape: "contents" },
    skill: {
      shape: "directory",
      subdir: "skills",
      place: "copy",
      register: [
        {
          file: "config.yaml",
          format: "yaml",
          at: ["skills", "dirs"],
          append: "{root}/skills",
          init: {},
        },
      ],
    },
    agent: {
      shape: "directory",
      subdir: "agents",
      entry: "AGENT.md",
      codec: { id: "frontmatter-set", set: { mode: "subagent" } },
    },
  },
};

const skill = () => join(project, ".tool", "skills", "lint");
const config = () => join(project, ".tool", "config.yaml");

test.beforeAll(async ({ aireg: run, tmp, project: dir, home }) => {
  [aireg, project] = [run, dir];
  await mkdir(join(home.aireg, "harnesses"), { recursive: true });
  await writeFile(join(home.aireg, "harnesses", "tool.json"), JSON.stringify(TOOL));
  const market = join(tmp, "market");
  await registry(market, { name: "fx", slug: "fx" })
    .skill("ns/lint@1.0.0", { description: "Lints.", body: "Run the linter.\n" })
    .agent("ns/reviewer@1.0.0", { files: { "AGENT.md": AGENT } })
    .write();
  expect((await aireg(["init", "-y", "--for", "tool"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "fx"])).code).toBe(0);
}, 60_000);

describe("a harness a file of yours defines", () => {
  test("takes each kind where it says, and says what it asks of you", async () => {
    const added = await aireg(["add", "fx/ns", "--all", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("Installed ns/lint and ns/reviewer for Tool.");
    expect(added.stderr).toContain(
      "Tool loads skills here only once you trust them: run `tool trust`.",
    );
    expect(added.stderr).toContain("Restart Tool to load the change.");

    expect((await lstat(skill())).isSymbolicLink()).toBe(false);
    expect(await readFile(join(project, ".tool", "agents", "reviewer", "AGENT.md"), "utf8")).toBe(
      "---\nname: reviewer\ndescription: Reviews code.\nmode: subagent\n---\n\nReview the diff.\n",
    );
    expect(await readFile(config(), "utf8")).toBe(
      `skills:\n  dirs:\n    - ${join(project, ".tool", "skills")} # aireg\n`,
    );

    const status = JSON.parse((await aireg(["status", "--json"])).stdout) as {
      data: { artifacts: { name: string; needsApproval?: unknown }[] };
    };
    expect(
      status.data.artifacts.map(({ name, needsApproval }) => ({ name, needsApproval })),
    ).toEqual([
      { name: "ns/lint", needsApproval: [{ harness: "tool", run: "tool trust" }] },
      { name: "ns/reviewer", needsApproval: undefined },
    ]);
  });

  test("keeps an edited copy until --force, then leaves its folder as it was", async () => {
    await appendFile(join(skill(), "SKILL.md"), "# mine\n");
    expect((await aireg(["status"])).code).toBe(3);
    expect((await aireg(["remove", "ns/lint", "-y"])).code).toBe(3);
    expect(existsSync(skill())).toBe(true);

    const removed = await aireg(["remove", "ns/lint", "ns/reviewer", "--force", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(skill())).toBe(false);
    expect(existsSync(join(project, ".tool", "agents"))).toBe(false);
    expect(existsSync(config())).toBe(false);
  });

  test("is named when a run cannot find the harness it would define", async ({ home }) => {
    const file = join(home.aireg, "harnesses", "tool.json");
    await writeFile(file, "{");
    const refused = await aireg(["add", "fx/ns", "--all", "--for", "tool", "-y"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(`aireg skipped ${file}: run \`aireg harnesses\` to see why.`);
  });
});
