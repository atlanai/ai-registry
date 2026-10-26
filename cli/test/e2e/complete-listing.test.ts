import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { test as base } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";

const body = (name: string) => `---\nname: ${name}\ndescription: Ships.\n---\nrun\n`;

function skill(name: string): string {
  const digest = createHash("sha256").update(body(name)).digest("hex");
  return [
    `{ id: 'skill_${name}', kind: 'skill', group: 'team', envelope: {`,
    "  apiVersion: 'aireg.sh/v1', kind: 'skill',",
    `  metadata: { name: '${name}', namespace: 'team', version: '1.0.0', description: 'Ships.' },`,
    `  files: [{ path: 'SKILL.md', digest: 'sha256:${digest}', size: ${Buffer.byteLength(body(name))},`,
    "    media_type: 'text/markdown', urls: ['x'] }] },",
    `  files: [{ path: 'SKILL.md', locator: '${name}', executable: false }] }`,
  ].join("\n");
}

// The adapter is loaded by each CLI run, so a file beside it says the registry deleted `fmt`.
function adapterSource(): string {
  return [
    "import { existsSync } from 'node:fs';",
    `const lint = ${skill("lint")};`,
    `const fmt = ${skill("fmt")};`,
    `const bodies = ${JSON.stringify({ lint: body("lint"), fmt: body("fmt") })};`,
    "export default {",
    "  id: 'drops', displayName: 'drops', protocol: 1, artifactKinds: ['skill'],",
    "  dispatch: { hosts: ['drops.example'] },",
    "  capabilities: { pinsSource: false },",
    "  connect: async () => ({",
    "    resolve: async () => existsSync(new URL('deleted', import.meta.url))",
    "      ? { artifacts: [lint], complete: true }",
    "      : { artifacts: [lint, fmt] },",
    "    fetch: async (_artifact, file) => new TextEncoder().encode(bodies[file.locator]),",
    "    close: async () => {},",
    "  }),",
    "};",
    "",
  ].join("\n");
}

const test = base.extend("deleted", async ({ home: { dir: home } }) => {
  const deleted = join(home, "deleted");
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "drops.mjs"), adapterSource());
  await writeFile(
    join(home, ".aireg", "config.yml"),
    [
      "schemaVersion: 1",
      "revision: 0",
      "adapters:",
      `  drops: ${join(home, "drops.mjs")}`,
      "accounts: []",
      "jobs: []",
      "",
    ].join("\n"),
  );
  return deleted;
});

describe("an artifact deleted from a registry installed whole", () => {
  test("is removed when the adapter says its listing is complete", async ({
    aireg,
    project,
    deleted,
  }) => {
    expect((await aireg(["init", "-y", "--for", "claude"])).code).toBe(0);
    const added = await aireg(["add", "https://drops.example", "--adapter", "drops", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    const fmt = join(project, ".claude", "skills", "fmt", "SKILL.md");
    expect(existsSync(fmt)).toBe(true);

    await writeFile(deleted, "");
    const synced = await aireg(["sync", "-y"]);
    expect(synced.code, synced.stderr).toBe(0);
    expect(existsSync(fmt)).toBe(false);
    const lock = parse(await readFile(lockPath(project), "utf8")) as {
      artifacts: Record<string, unknown>;
    };
    expect(Object.keys(lock.artifacts)).toEqual(["team/lint"]);
  });

  test("is kept as a conflict when edited here", async ({ aireg, project, deleted }) => {
    expect((await aireg(["init", "-y", "--for", "claude"])).code).toBe(0);
    expect((await aireg(["add", "https://drops.example", "--adapter", "drops", "-y"])).code).toBe(
      0,
    );
    const fmt = join(project, ".claude", "skills", "fmt", "SKILL.md");
    await appendFile(fmt, "mine\n");

    await writeFile(deleted, "");
    const synced = await aireg(["sync", "-y"]);
    const output = `${synced.stdout}${synced.stderr}`;
    expect(synced.code, output).toBe(3);
    expect(existsSync(fmt)).toBe(true);
    expect(output).toContain("edited here and deleted from the registry");
    // The adapter cannot publish and names nowhere else, so the hint offers a registry of your own.
    expect(output).toContain("keep yours by publishing it to a registry of your own");
  });

  test("is removed, and reported so, when the registry's side is taken", async ({
    aireg,
    project,
    deleted,
  }) => {
    expect((await aireg(["init", "-y", "--for", "claude"])).code).toBe(0);
    expect((await aireg(["add", "https://drops.example", "--adapter", "drops", "-y"])).code).toBe(
      0,
    );
    const fmt = join(project, ".claude", "skills", "fmt", "SKILL.md");
    // Settled twice, since the text and the JSON each need a conflict of their own.
    const resolve = async (format: string[]) => {
      await rm(deleted, { force: true });
      expect((await aireg(["sync", "-y"])).code).toBe(0);
      await appendFile(fmt, "mine\n");
      await writeFile(deleted, "");
      expect((await aireg(["sync", "-y"])).code).toBe(3);
      const resolved = await aireg(["sync", "resolve", "fmt", "--theirs", ...format]);
      expect(resolved.code, resolved.stderr).toBe(0);
      expect(existsSync(fmt)).toBe(false);
      return resolved;
    };

    expect((await resolve([])).stdout).toMatch(/removed\s+team\/fmt/);
    const { data } = JSON.parse((await resolve(["--json"])).stdout) as {
      data: { artifacts: { name: string; operation: string }[] };
    };
    expect(data.artifacts).toEqual([
      expect.objectContaining({ name: "team/fmt", operation: "remove-local" }),
    ]);
  });
});
