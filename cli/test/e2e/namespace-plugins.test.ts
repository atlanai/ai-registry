import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";

/** An adapter serving one skill in the namespace `team`, declaring `namespacePlugins` or not. */
function adapterSource(id: string, skill: string, namespacePlugins: boolean): string {
  const body = `---\nname: ${skill}\ndescription: Ships.\n---\nrun\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  return [
    "export default {",
    `  id: '${id}', displayName: '${id}', protocol: 1, artifactKinds: ['skill'],`,
    `  dispatch: { hosts: ['${id}.example'] },`,
    `  capabilities: { pinsSource: false, namespacePlugins: ${namespacePlugins} },`,
    "  connect: async () => ({",
    "    resolve: async () => ({ artifacts: [{",
    `      id: 'skill_${skill}', kind: 'skill', group: 'team',`,
    "      envelope: {",
    "        apiVersion: 'aireg.sh/v1', kind: 'skill',",
    `        metadata: { name: '${skill}', namespace: 'team', version: '1.0.0', description: 'Ships.' },`,
    `        files: [{ path: 'SKILL.md', digest: 'sha256:${digest}', size: ${Buffer.byteLength(body)},`,
    "          media_type: 'text/markdown', urls: ['SKILL.md'] }],",
    "      },",
    "      files: [{ path: 'SKILL.md', locator: 'skill', executable: false }],",
    "    }] }),",
    `    fetch: async () => new TextEncoder().encode(${JSON.stringify(body)}),`,
    "    close: async () => {},",
    "  }),",
    "};",
    "",
  ].join("\n");
}

const test = base.extend("adapters", async ({ home: { dir: home } }) => {
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, "wraps.mjs"), adapterSource("wraps", "deploy", true));
  await writeFile(join(home, "loose.mjs"), adapterSource("loose", "lint", false));
  await writeFile(
    join(home, ".aireg", "config.yml"),
    [
      "schemaVersion: 1",
      "revision: 0",
      "adapters:",
      `  wraps: ${join(home, "wraps.mjs")}`,
      `  loose: ${join(home, "loose.mjs")}`,
      "accounts: []",
      "jobs: []",
      "",
    ].join("\n"),
  );
  return home;
});

const add = (id: string, skill: string) => [
  "add",
  "-g",
  `https://${id}.example`,
  "--adapter",
  id,
  "--select",
  skill,
  "--no-auto-update",
  "--yes",
];

describe("a source that declares its namespaces plugins", () => {
  test("installs its namespace as one plugin per harness, with a row per skill", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    const added = await aireg(add("wraps", "deploy"), { cwd: tmp });
    expect(added.code, added.stderr).toBe(0);

    const plugin = join(home, ".claude", "skills", "team");
    expect(lstatSync(plugin).isSymbolicLink()).toBe(true);
    expect(existsSync(join(plugin, "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(plugin, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "plugins", "cache", "wraps", "team", "local"))).toBe(
      true,
    );
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain(
      '[plugins."team@wraps"]',
    );
    expect(existsSync(join(home, ".claude", "skills", "deploy"))).toBe(false);

    const lock = await readFile(join(home, ".registry", "manifest.lock.yml"), "utf8");
    expect(lock).toMatch(/kind: skill/);
    expect(lock).toMatch(/namespace: team/);
    expect(lock).not.toMatch(/kind: plugin/);
  }, 60_000);
});

describe("a source that does not", () => {
  test("installs each skill as itself, where each harness reads it", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    const added = await aireg(add("loose", "lint"), { cwd: tmp });
    expect(added.code, added.stderr).toBe(0);

    expect(existsSync(join(home, ".claude", "skills", "lint", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".agents", "skills", "lint", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "team"))).toBe(false);
    expect(existsSync(join(home, ".codex", "plugins"))).toBe(false);
    expect(existsSync(join(home, ".registry", "artifacts", ".projections"))).toBe(false);
  }, 60_000);
});

describe("a Codex home kept in a dotfiles folder", () => {
  test("loses its plugin entries on remove when CODEX_HOME names the real folder", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    const real = join(home, "dotfiles", "codex");
    await mkdir(real, { recursive: true });
    await rm(join(home, ".codex"), { recursive: true });
    await symlink(real, join(home, ".codex"));
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);

    const remove = ["remove", "-g", "team/deploy", "--force", "--yes"];
    const removed = await aireg(remove, { cwd: tmp, env: { CODEX_HOME: real } });
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(join(real, "config.toml"))).toBe(false);
  }, 60_000);

  test("says which file it left when a folder in it is a link, on remove too", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    const cache = join(home, ".codex", "plugins", "cache", "wraps");
    await mkdir(cache, { recursive: true });
    await mkdir(join(home, "elsewhere"));
    await symlink(join(home, "elsewhere"), join(cache, ".agents"));
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);

    const removed = await aireg(["remove", "-g", "team/deploy", "--force", "--yes"], { cwd: tmp });
    expect(removed.stderr).toContain(
      "as it is for team: plugins/cache/wraps/.agents is a symlink.",
    );
    expect(removed.stderr).not.toContain("Did not install");
  }, 60_000);
});
