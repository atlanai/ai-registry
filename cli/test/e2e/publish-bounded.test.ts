import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

interface Held {
  name: string;
  version: string;
  content: string;
  relationships?: { rel_type: string; to: string }[];
}

const REVIEW = skillBody("review", "The review checklist.");
const EDGE = { rel_type: "depends_on", to: "eng/skill/style@2.0.0" };

const test = base.extend("bounded", async ({ home: { dir: home }, project }) => {
  const adapter = join(home, "bounded.mjs");
  const state = join(home, "held.json");
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(
    adapter,
    [
      "import { createHash } from 'node:crypto';",
      "import { readFileSync } from 'node:fs';",
      "const digest = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');",
      "const artifactOf = ({ name, version, content, relationships }) => ({",
      "  id: 'eng/skill/' + name + '@' + version, kind: 'skill', version, group: 'eng',",
      "  envelope: {",
      "    apiVersion: 'aireg.sh/v1', kind: 'skill',",
      "    metadata: { name, namespace: 'eng', version },",
      "    files: [{ path: 'SKILL.md', digest: digest(content), size: Buffer.byteLength(content) }],",
      "    ...(relationships === undefined ? {} : { relationships }),",
      "  },",
      "  files: [{ path: 'SKILL.md', locator: name + '/SKILL.md', executable: false }],",
      "});",
      "export default {",
      "  id: 'bounded',",
      "  displayName: 'Bounded', protocol: 1, artifactKinds: ['skill'],",
      "  dispatch: { hosts: ['bounded.example'] },",
      "  capabilities: { publish: true, relationships: true },",
      "  connect: async () => ({",
      "    resolve: async (want) => {",
      `      const held = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));`,
      "      const named = held.filter((item) => want.some((each) =>",
      "        each.name === item.name && (each.namespace ?? 'eng') === 'eng' &&",
      "        (each.kind ?? 'skill') === 'skill' &&",
      "        (each.version === undefined || each.version === item.version)));",
      "      return { artifacts: named.map(artifactOf) };",
      "    },",
      "    fetch: async () => new Uint8Array(),",
      "    publish: async () => ({}),",
      "    close: async () => {},",
      "  }),",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(home, ".aireg", "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  bounded: ${adapter}\naccounts: []\njobs: []\n`,
  );
  for (const [name, body] of [
    ["review", REVIEW],
    ["style", skillBody("style", "The style guide.")],
  ] as const) {
    await mkdir(join(project, ".claude", "skills", name), { recursive: true });
    await writeFile(join(project, ".claude", "skills", name, "SKILL.md"), body);
  }
  await writeManifestIn(
    project,
    `registries:
  hosted:
    source: https://bounded.example
    adapter: bounded
exports:
  - path: .claude/skills/review
    depends_on: [./.claude/skills/style]
  - .claude/skills/style
publish:
  to: hosted/eng
`,
  );
  return (held: Held[]) => writeFile(state, JSON.stringify(held));
});

describe("publishing to a registry that bounds its whole listing", () => {
  const style = { name: "style", version: "2.0.0", content: "Older style.\n" };

  test("plans an artifact it holds as an update from its latest, not a new one", async ({
    aireg,
    bounded: hold,
  }) => {
    await hold([style]);
    const shown = await aireg(["publish", ".claude/skills/style", "--dry-run", "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).data.artifacts).toEqual([
      expect.objectContaining({ name: "style", from: "2.0.0", version: "2.0.1" }),
    ]);
  }, 60_000);

  test("names a dependency it holds, and finds one already published the same", async ({
    aireg,
    bounded: hold,
  }) => {
    await hold([{ name: "review", version: "1.2.0", content: "Older review.\n" }, style]);
    const shown = await aireg(["publish", ".claude/skills/review", "--dry-run", "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).data.artifacts).toEqual([
      expect.objectContaining({
        name: "review",
        from: "1.2.0",
        version: "1.2.1",
        dependsOn: [{ to: EDGE.to }],
      }),
    ]);

    await hold([
      { name: "review", version: "1.2.0", content: REVIEW, relationships: [EDGE] },
      style,
    ]);
    const same = await aireg(["publish", ".claude/skills/review", "--dry-run"]);
    expect(same.code, same.stderr).toBe(0);
    expect(same.stdout).toMatch(/same {4}eng\/skill\/review {2}1\.2\.0, already published/);
  }, 60_000);
});
