import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

const test = base.extend("skillsOnly", async ({ home: { dir: home }, project }) => {
  const adapter = join(home, "skills-only.mjs");
  const sent = join(home, "sent.jsonl");
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(
    adapter,
    [
      "import { appendFileSync } from 'node:fs';",
      "export default {",
      "  id: 'skills-only',",
      "  displayName: 'Skills only', protocol: 1, artifactKinds: ['skill', 'agent'],",
      "  publishKinds: ['skill'],",
      "  dispatch: { hosts: ['skills.example'] },",
      "  capabilities: { publish: true, relationships: true },",
      "  connect: async () => ({",
      "    resolve: async () => ({ artifacts: [] }),",
      "    fetch: async () => new Uint8Array(),",
      "    publish: async (inputs) => {",
      "      for (const input of inputs) {",
      "        const { name, kind, relationships } = input;",
      `        appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ name, kind, relationships }) + '\\n');`,
      "      }",
      "      return {};",
      "    },",
      "    close: async () => {},",
      "  }),",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(home, ".aireg", "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  skills-only: ${adapter}\naccounts: []\njobs: []\n`,
  );
  await mkdir(join(project, ".claude", "skills", "review"), { recursive: true });
  await writeFile(
    join(project, ".claude", "skills", "review", "SKILL.md"),
    skillBody("review", "The review checklist."),
  );
  await mkdir(join(project, ".claude", "agents"), { recursive: true });
  await writeFile(
    join(project, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews a pull request.\n---\nReview it.\n",
  );
  return sent;
});

const REGISTRIES = `registries:
  hosted:
    source: https://skills.example
    adapter: skills-only
`;

const SKIPPED = {
  name: "reviewer",
  kind: "agent",
  path: ".claude/agents/reviewer.md",
  reason: "hosted does not take agents",
};

describe("publishing exports to a registry that takes only some kinds", () => {
  test("publishes the rest, leaving out each edge to what it skips", async ({
    aireg,
    project,
    skillsOnly: sent,
  }) => {
    await writeManifestIn(
      project,
      `${REGISTRIES}exports:
  - .claude/agents/reviewer.md
  - path: .claude/skills/review
    depends_on: [./.claude/agents/reviewer.md]
publish:
  to: hosted/eng
`,
    );
    const shown = await aireg(["publish", "--dry-run"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(
      /add {5}eng\/skill\/review {2}0\.1\.0\n {2}skip {4}eng\/agent\/reviewer {2}hosted does not take agents/,
    );
    expect(shown.stderr).toContain(
      "warning: Left out the dependency of review on reviewer, since hosted does not take agents.",
    );

    const published = await aireg(["publish", "--yes", "--json"]);
    expect(published.code, published.stderr).toBe(0);
    const { data } = JSON.parse(published.stdout);
    expect(data.target).toEqual({ registry: "hosted", namespace: "eng" });
    expect(data.artifacts).toEqual([
      expect.objectContaining({ name: "review", kind: "skill", published: true, dependsOn: [] }),
    ]);
    expect(data.skipped).toEqual([SKIPPED]);
    const lines = (await readFile(sent, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ name: "review", kind: "skill" }]);
  }, 60_000);

  test("says nothing is left to publish when it takes none of them, and succeeds", async ({
    aireg,
    project,
    skillsOnly: sent,
  }) => {
    await writeManifestIn(
      project,
      `${REGISTRIES}exports:\n  - .claude/agents/reviewer.md\npublish:\n  to: hosted/eng\n`,
    );
    const shown = await aireg(["publish", "--yes"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("Nothing to publish.");
    expect(shown.stdout).toContain("skip    eng/agent/reviewer  hosted does not take agents");
    const json = await aireg(["publish", "--yes", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data).toEqual({
      dryRun: false,
      target: { registry: "hosted", namespace: "eng" },
      artifacts: [],
      skipped: [SKIPPED],
    });
    expect(existsSync(sent)).toBe(false);
  }, 60_000);
});
