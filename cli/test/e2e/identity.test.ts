import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath, writeManifestIn } from "#test/kit/scope.ts";
import { projected } from "#test/kit/target.ts";

/** A project, and a home whose config registers an adapter serving one skill. */
const test = base.extend("hosted", async ({ home: { dir: home }, project }) => {
  const adapter = join(home, "hosted.mjs");
  const body = "---\nname: lint\n---\nrun\n";
  const digest = createHash("sha256").update(body).digest("hex");
  const size = Buffer.byteLength(body);
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await mkdir(join(project, ".claude"), { recursive: true });
  // A project is where a manifest is, so `add` installs here rather than for the user.
  await writeManifestIn(project, "registries: {}\nartifacts: []\n");
  await writeFile(
    adapter,
    [
      "export default {",
      "  id: 'hosted',",
      "  displayName: 'Hosted', protocol: 1, artifactKinds: ['skill'],",
      "  dispatch: { hosts: ['registry.example'] },",
      "  capabilities: { pinsSource: false },",
      "  connect: async () => ({",
      "    resolve: async () => ({ artifacts: [{",
      "      id: 'skill_123', kind: 'skill',",
      "      envelope: {",
      "        apiVersion: 'aireg.sh/v1', kind: 'skill',",
      "        metadata: { name: 'lint', version: '1.2.0', description: 'Lints.' },",
      `        files: [{ path: 'SKILL.md', digest: 'sha256:${digest}', size: ${size},`,
      "          media_type: 'text/markdown', urls: ['SKILL.md'] }],",
      "      },",
      "      files: [{ path: 'SKILL.md', locator: 'skill', executable: false }],",
      "    }] }),",
      `    fetch: async () => new TextEncoder().encode(${JSON.stringify(body)}),`,
      "    close: async () => {},",
      "  }),",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(home, ".aireg", "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  hosted: ${adapter}\naccounts: []\njobs: []\n`,
  );
  return adapter;
});

describe("adapter identity, end to end", () => {
  test("persists remote scope and installs an artifact under an explicit local name", async ({
    aireg,
    project,
    hosted: _,
  }) => {
    const added = await aireg([
      "add",
      "https://registry.example",
      "--adapter",
      "hosted",
      "--config",
      "team=team_123",
      "--select",
      "lint",
      "--yes",
    ]);
    expect(added.code, added.stderr).toBe(0);

    const original = await readFile(manifestPath(project), "utf8");
    const lock = await readFile(lockPath(project), "utf8");
    expect(original).toContain("team: team_123");
    // `add` writes the kind into the address, which is what makes it unambiguous.
    expect(original).toContain("- hosted/skill/lint");
    expect(lock).toMatch(/key: sha256:[0-9a-f]{64}/);
    expect(lock).toContain("id: skill_123");
    expect(lock).toContain("adapter: hosted");

    await writeManifestIn(
      project,
      original.replace("  - hosted/skill/lint", "  - ref: hosted/skill/lint\n    as: team-lint"),
    );
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(await readFile(projected(project, "team-lint"), "utf8")).toContain("run");
    const outdated = await aireg(["outdated"]);
    expect(outdated.code, `${outdated.stdout}\n${outdated.stderr}`).toBe(0);

    const removed = await aireg(["remove", "team-lint", "--yes"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(join(project, ".claude", "skills", "team-lint"))).toBe(false);
  });
});
