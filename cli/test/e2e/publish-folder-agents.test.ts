import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let aireg: Aireg;
/** The repository that makes the agent, with its registry folder inside it. */
let maker: string;
/** Another project, which installs from that registry folder. */
let project: string;

const MANIFEST = `exports:
  - skills
  - path: agents/websiteclaw
    ignore: [runtime/]
    include:
      - workspace
      - runtime
      - { from: notes/SOUL.md, as: identity/SOUL.md }
    depends_on:
      - ./skills/pr-approval
      - ./agents/websiteclaw/skills/site-health
  - agents/websiteclaw/skills
publish:
  to: ./registry/marketing
`;

const agent = (...parts: string[]) => join(maker, "agents", "websiteclaw", ...parts);
const versionDir = (kind: string, name: string, version: string) =>
  join(maker, "registry", "artifacts", "marketing", kind, name, version);

async function filesIn(dir: string): Promise<string[]> {
  const found = await readdir(dir, { recursive: true, withFileTypes: true });
  return found
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

const publish = (...args: string[]) => aireg(["publish", ...args], { cwd: maker });

test.beforeAll(async ({ aireg: run, tmp, project: dir, git }) => {
  [aireg, maker, project] = [run, join(tmp, "maker"), dir];
  await git.init(maker);
  await mkdir(join(maker, "skills", "pr-approval"), { recursive: true });
  await writeFile(
    join(maker, "skills", "pr-approval", "SKILL.md"),
    skillBody("pr-approval", "Approves a pull request."),
  );
  for (const [path, body] of [
    [
      "AGENT.md",
      "---\nname: websiteclaw\ndescription: Looks after the website.\n---\nKeep it up.\n",
    ],
    ["workspace/AGENTS.md", "How the workspace is laid out.\n"],
    ["workspace/TOOLS.md", "The tools it uses.\n"],
    ["notes/SOUL.md", "Who it is.\n"],
    ["notes/scratch.md", "Not published.\n"],
    ["runtime/state.json", "{}\n"],
    ["skills/site-health/SKILL.md", skillBody("site-health", "Checks the site.")],
  ] as const) {
    await mkdir(join(agent(path), ".."), { recursive: true });
    await writeFile(agent(path), body);
  }
  await writeManifestIn(maker, MANIFEST);
  await git(maker, "add", ".");
  await git(maker, "commit", "-qm", "agents");
  const made = await aireg(["registry", "init", "registry", "--name", "maker", "-y"], {
    cwd: maker,
  });
  expect(made.code, made.stderr).toBe(0);
});

describe("publishing a folder agent", () => {
  test("lists its files, AGENT.md first, under --dry-run --json", async () => {
    const shown = await publish("--dry-run", "--json");
    expect(shown.code, shown.stderr).toBe(0);
    const { artifacts } = JSON.parse(shown.stdout).data as {
      artifacts: { name: string; kind: string; files?: string[] }[];
    };
    // `site-health` comes after what it depends on.
    expect(artifacts.map(({ name, kind, files }) => ({ name, kind, files }))).toEqual([
      { name: "pr-approval", kind: "skill", files: undefined },
      { name: "site-health", kind: "skill", files: undefined },
      {
        name: "websiteclaw",
        kind: "agent",
        files: ["AGENT.md", "identity/SOUL.md", "workspace/AGENTS.md", "workspace/TOOLS.md"],
      },
    ]);
  });

  test("writes exactly its files into its version folder, and nothing again on a rerun", async () => {
    const sent = await publish("-y");
    expect(sent.code, sent.stderr).toBe(0);
    expect(await filesIn(versionDir("agent", "websiteclaw", "0.1.0"))).toEqual([
      "AGENT.md",
      "artifact.json",
      "identity/SOUL.md",
      "workspace/AGENTS.md",
      "workspace/TOOLS.md",
    ]);
    expect(
      await readFile(
        join(versionDir("agent", "websiteclaw", "0.1.0"), "identity", "SOUL.md"),
        "utf8",
      ),
    ).toBe("Who it is.\n");
    const envelope = JSON.parse(
      await readFile(join(versionDir("agent", "websiteclaw", "0.1.0"), "artifact.json"), "utf8"),
    );
    expect(envelope.relationships).toEqual([
      { rel_type: "depends_on", to: "marketing/skill/pr-approval@0.1.0" },
      { rel_type: "depends_on", to: "marketing/skill/site-health@0.1.0" },
    ]);
    expect(await filesIn(versionDir("skill", "site-health", "0.1.0"))).toEqual([
      "SKILL.md",
      "artifact.json",
    ]);
    const valid = await aireg(["registry", "validate"], { cwd: join(maker, "registry") });
    expect(valid.code, valid.stdout + valid.stderr).toBe(0);
    const again = await publish("--dry-run");
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(
      /same {4}marketing\/agent\/websiteclaw {2}0\.1\.0, already published/,
    );
    expect(again.stdout).toContain("Nothing new to publish.");
  });

  test("publishes a new version when one included file changes, and none for one left out", async () => {
    await writeFile(agent("runtime", "state.json"), '{"run": 2}\n');
    await writeFile(agent("notes", "scratch.md"), "Still not published.\n");
    expect((await publish("--dry-run")).stdout).toContain("Nothing new to publish.");
    await writeFile(agent("workspace", "TOOLS.md"), "The tools it uses, and one more.\n");
    const sent = await publish("-y");
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update {2}marketing\/agent\/websiteclaw {2}0\.1\.0 → 0\.1\.1/);
    expect(
      await readFile(
        join(versionDir("agent", "websiteclaw", "0.1.1"), "workspace", "TOOLS.md"),
        "utf8",
      ),
    ).toBe("The tools it uses, and one more.\n");
  });

  test("installs into a project as its AGENT.md alone, saying which files it left out", async () => {
    await mkdir(join(project, ".claude"), { recursive: true });
    expect((await aireg(["init", "-y"])).code).toBe(0);
    const declared = await aireg(["registry", "add", join(maker, "registry"), "--as", "maker"]);
    expect(declared.code, declared.stderr).toBe(0);
    const added = await aireg(["add", "maker/marketing/agent/websiteclaw", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(
      "marketing/websiteclaw 0.1.1 installs as its AGENT.md alone, since a target takes an agent as one file, so identity/SOUL.md, workspace/AGENTS.md and workspace/TOOLS.md are left out.",
    );
    expect(await readFile(join(project, ".claude", "agents", "websiteclaw.md"), "utf8")).toBe(
      await readFile(agent("AGENT.md"), "utf8"),
    );

    const again = await aireg(["install"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).not.toContain("left out");
  });
});
