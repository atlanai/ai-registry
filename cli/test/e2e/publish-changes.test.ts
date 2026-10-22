import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let aireg: Aireg;
/** The repository that makes the agent, with its registry folder inside it. */
let maker: string;
/** Each artifact's digest as first published. */
let published: Map<string, string>;

const MANIFEST = `exports:
  - skills
  - path: agents/websiteclaw
    depends_on: [./skills/pr-approval]
publish:
  to: ./registry/marketing
`;

const agent = (...parts: string[]) => join(maker, "agents", "websiteclaw", ...parts);
const publish = (...args: string[]) => aireg(["publish", ...args], { cwd: maker });

const digestsOf = (stdout: string) =>
  (JSON.parse(stdout).data.artifacts as { name: string; digest: string }[]).map(
    ({ name, digest }) => [name, digest] as const,
  );

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

test.beforeAll(async ({ aireg: run, tmp, git }) => {
  [aireg, maker] = [run, join(tmp, "maker")];
  await git.init(maker);
  await write(join(maker, "skills", "pr-approval", "SKILL.md"), skillBody("pr-approval"));
  await write(
    agent("AGENT.md"),
    "---\nname: websiteclaw\ndescription: Looks after the website.\n---\nKeep it up.\n",
  );
  await write(agent("identity", "SOUL.md"), "Who it is.\n");
  await write(agent("identity", "MEMORY.md"), "What it remembers.\n");
  await writeManifestIn(maker, MANIFEST);
  await git(maker, "add", ".");
  await git(maker, "commit", "-qm", "agent");
  const made = await aireg(["registry", "init", "registry", "--name", "maker", "-y"], {
    cwd: maker,
  });
  expect(made.code, made.stderr).toBe(0);
  const first = await publish("-y", "--json");
  expect(first.code, first.stderr).toBe(0);
  published = new Map(digestsOf(first.stdout));

  await write(agent("identity", "SOUL.md"), "Who it is now.\n");
  await write(agent("workspace", "NEW.md"), "A new file.\n");
  await git(maker, "rm", "-q", "agents/websiteclaw/identity/MEMORY.md");
  await write(
    join(maker, "skills", "pr-approval", "SKILL.md"),
    skillBody("pr-approval", "pr-approval", "Approve only green builds.\n"),
  );
  await git(maker, "add", ".");
  await git(maker, "commit", "-qm", "change");
}, 60_000);

describe("a dry run of an update", () => {
  test("lists the files and dependencies each update changes", async () => {
    const shown = await publish("--dry-run");
    expect(shown.code, shown.stderr).toBe(0);
    const plan = shown.stdout.split("\n").slice(1).join("\n");
    expect(plan).toBe(`  update  marketing/skill/pr-approval  0.1.0 → 0.1.1
    changed  SKILL.md
  update  marketing/agent/websiteclaw  0.1.0 → 0.1.1, depends on pr-approval 0.1.1
    changed  identity/SOUL.md
    removed  identity/MEMORY.md
    added    workspace/NEW.md
    removed  depends on marketing/skill/pr-approval@0.1.0
    added    depends on marketing/skill/pr-approval@0.1.1
`);
  });

  test("gives them as filesChanged and dependsOnChanged under --json", async () => {
    const shown = await publish("--dry-run", "--json");
    expect(shown.code, shown.stderr).toBe(0);
    const { artifacts } = JSON.parse(shown.stdout).data as {
      artifacts: { name: string; filesChanged?: unknown; dependsOnChanged?: unknown }[];
    };
    expect(
      artifacts.map(({ name, filesChanged, dependsOnChanged }) => ({
        name,
        filesChanged,
        dependsOnChanged,
      })),
    ).toEqual([
      {
        name: "pr-approval",
        filesChanged: { added: [], changed: ["SKILL.md"], removed: [] },
        dependsOnChanged: undefined,
      },
      {
        name: "websiteclaw",
        filesChanged: {
          added: ["workspace/NEW.md"],
          changed: ["identity/SOUL.md"],
          removed: ["identity/MEMORY.md"],
        },
        dependsOnChanged: {
          added: ["marketing/skill/pr-approval@0.1.1"],
          removed: ["marketing/skill/pr-approval@0.1.0"],
        },
      },
    ]);
  });

  test("gives each artifact a digest of its content, which an edit moves", async () => {
    const shown = await publish("--dry-run", "--json");
    expect(shown.code, shown.stderr).toBe(0);
    const digests = digestsOf(shown.stdout);
    expect(digests.map(([, digest]) => digest)).toEqual([
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    ]);
    for (const [name, digest] of digests) expect(digest).not.toBe(published.get(name));
  });
});
