import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

/** An adapter serving several skills, each in its own namespace, as plugins. */
function namespacesSource(id: string, skills: readonly { group: string; name: string }[]): string {
  const artifacts = skills.map(({ group, name }) => {
    const body = `---\nname: ${name}\ndescription: Ships.\n---\n${group}\n`;
    const digest = createHash("sha256").update(body).digest("hex");
    return [
      "{",
      `  id: 'skill_${group}_${name}', kind: 'skill', group: '${group}',`,
      "  envelope: {",
      "    apiVersion: 'aireg.sh/v1', kind: 'skill',",
      `    metadata: { name: '${name}', namespace: '${group}', version: '1.0.0', description: 'Ships.' },`,
      `    files: [{ path: 'SKILL.md', digest: 'sha256:${digest}', size: ${Buffer.byteLength(body)},`,
      `      media_type: 'text/markdown', urls: ['${group}/${name}'] }],`,
      "  },",
      `  files: [{ path: 'SKILL.md', locator: '${group}/${name}', executable: false }],`,
      "}",
    ].join("\n");
  });
  const bodies = Object.fromEntries(
    skills.map(({ group, name }) => [
      `${group}/${name}`,
      `---\nname: ${name}\ndescription: Ships.\n---\n${group}\n`,
    ]),
  );
  return [
    `const bodies = ${JSON.stringify(bodies)};`,
    "export default {",
    `  id: '${id}', displayName: '${id}', protocol: 1, artifactKinds: ['skill'],`,
    `  dispatch: { hosts: ['${id}.example'] },`,
    "  capabilities: { pinsSource: false, namespacePlugins: true },",
    "  connect: async () => ({",
    `    resolve: async () => ({ artifacts: [${artifacts.join(",")}] }),`,
    "    fetch: async (_artifact, file) => new TextEncoder().encode(bodies[file.locator]),",
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
    join(home, "teams.mjs"),
    namespacesSource("teams", [
      { group: "team", name: "deploy" },
      { group: "ops", name: "deploy" },
      { group: "ops", name: "audit" },
    ]),
  );
  await writeFile(
    join(home, ".aireg", "config.yml"),
    [
      "schemaVersion: 1",
      "revision: 0",
      "adapters:",
      `  wraps: ${join(home, "wraps.mjs")}`,
      `  loose: ${join(home, "loose.mjs")}`,
      `  teams: ${join(home, "teams.mjs")}`,
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
  test("installs its namespace as one plugin per target, with a row per skill", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    const added = await aireg(add("wraps", "deploy"), { cwd: tmp });
    expect(added.code, added.stderr).toBe(0);

    const plugin = join(home, ".claude", "aireg", "wraps", "namespaces", "team");
    expect(lstatSync(plugin).isSymbolicLink()).toBe(true);
    expect(existsSync(join(plugin, "skills", "deploy", "SKILL.md"))).toBe(true);
    const merged = join(home, ".claude", "aireg", "wraps");
    expect(lstatSync(join(merged, "skills", "deploy")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(merged, "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(merged, ".claude-plugin", "plugin.json"), "utf8")),
    ).toMatchObject({ name: "wraps" });
    expect(
      JSON.parse(
        await readFile(
          join(home, ".claude", "aireg", ".claude-plugin", "marketplace.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      name: "aireg",
      owner: { name: "aireg" },
      plugins: [
        {
          name: "wraps",
          description: "Artifacts the wraps registry publishes, kept current by aireg.",
          source: { source: "command", command: "aireg targets plugin-dir wraps", mode: "link" },
        },
      ],
    });
    expect(existsSync(join(home, ".claude", "skills", "team"))).toBe(false);
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
  });
});

describe("a project that installs a source's namespace", () => {
  test("links each skill where Claude Code reads it, merging nothing", async ({
    aireg,
    adapters: home,
    project,
  }) => {
    await mkdir(join(project, ".git"));
    const added = await aireg(
      add("wraps", "deploy").filter((arg) => arg !== "-g"),
      { cwd: project },
    );
    expect(added.code, added.stderr).toBe(0);

    expect(existsSync(join(project, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "aireg"))).toBe(false);
    expect(existsSync(join(home, ".claude", "aireg"))).toBe(false);
  });
});

describe("a source that does not", () => {
  test("installs each skill as itself, where each target reads it", async ({
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
  });
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
  });

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
  });
});

describe("a target that merges a registry's namespaces into one plugin", () => {
  const merged = (home: string) => join(home, ".claude", "aireg", "wraps");
  const marketplace = (home: string) =>
    join(home, ".claude", "aireg", ".claude-plugin", "marketplace.json");

  test("drops the plugin and its marketplace entry with the last namespace", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);

    const removed = await aireg(["remove", "-g", "team/deploy", "--force", "--yes"], { cwd: tmp });
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(join(merged(home), "skills"))).toBe(false);
    expect(existsSync(join(merged(home), ".claude-plugin"))).toBe(false);
    expect(existsSync(join(merged(home), "namespaces"))).toBe(false);
    expect(existsSync(marketplace(home))).toBe(false);
  });

  test("moves a namespace linked where Claude Code reads skills on the next sync", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);
    // As an earlier aireg left it: the namespace linked among the skills, and no merged plugin.
    const lockFile = join(home, ".registry", "manifest.lock.yml");
    const lock = await readFile(lockFile, "utf8");
    expect(lock).toContain(".claude/aireg/wraps/namespaces/team");
    await writeFile(
      lockFile,
      lock.replace(".claude/aireg/wraps/namespaces/team", ".claude/skills/team"),
    );
    await rm(join(home, ".claude", "aireg"), { recursive: true });
    const legacy = join(home, ".claude", "skills", "team");
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink(
      join("..", "..", ".registry", "artifacts", ".projections", "wraps", "team"),
      legacy,
    );

    const synced = await aireg(["sync", "-g", "--yes"], { cwd: tmp });
    expect(synced.code, synced.stderr).toBe(0);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(merged(home), "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(marketplace(home))).toBe(true);
    expect(await readFile(lockFile, "utf8")).not.toContain(".claude/skills/team");
  });

  test("names a skill two namespaces hold after each, and the rest as they are", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    const added = await aireg(
      [
        "add",
        "-g",
        "https://teams.example",
        "--adapter",
        "teams",
        "--all",
        "--no-auto-update",
        "--yes",
      ],
      { cwd: tmp },
    );
    expect(added.code, added.stderr).toBe(0);
    const skills = join(home, ".claude", "aireg", "teams", "skills");
    expect((await readdir(skills)).sort()).toEqual(["audit", "ops-deploy", "team-deploy"]);
    expect(await readFile(join(skills, "ops-deploy", "SKILL.md"), "utf8")).toContain("ops");
    expect(await readFile(join(skills, "team-deploy", "SKILL.md"), "utf8")).toContain("team");
  });
});

/** A `claude` that logs each call and lists what it was asked to install. */
const FAKE_CLAUDE = `#!/bin/sh
set -eu
here=$(dirname "$0")
echo "$*" >> "$here/calls.log"
case "$*" in
  "plugin list --json") printf '[%s]' "$(cat "$here/installed" 2>/dev/null || true)" ;;
  "plugin install "*) printf '{"id":"%s"}' "$3" > "$here/installed" ;;
esac
`;

describe("aireg targets setup and plugin-dir", () => {
  const withClaude = async (home: string) => {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
    return { PATH: `${bin}:${process.env.PATH ?? ""}` };
  };

  test("plugin-dir prints the merged folder alone, and refuses a registry it does not hold", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);

    const printed = await aireg(["targets", "plugin-dir", "wraps"], { cwd: tmp });
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(`${join(home, ".claude", "aireg", "wraps")}\n`);

    const missing = await aireg(["targets", "plugin-dir", "nope"], { cwd: tmp });
    expect(missing.code).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain('No plugin holds the registry "nope"');
  });

  test("setup lists the marketplace, and leaves the install to a person when none is at hand", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);
    const env = await withClaude(home);

    const set = await aireg(["targets", "setup", "--json"], { cwd: tmp, env });
    expect(set.code, set.stderr).toBe(0);
    const calls = await readFile(join(home, "bin", "calls.log"), "utf8");
    expect(calls).toContain(`plugin marketplace add ${join(home, ".claude", "aireg")}`);
    expect(calls).not.toContain("plugin install");
    const { data } = JSON.parse(set.stdout);
    expect(data.steps).toEqual([
      {
        target: "claude-code",
        registry: "wraps",
        outcome: "needs-person",
        run: "claude plugin install wraps@aireg",
      },
    ]);
    const claude = data.targets.find((each: { target: string }) => each.target === "claude-code");
    expect(claude.plugins).toEqual([
      {
        registry: "wraps",
        folder: join(home, ".claude", "aireg", "wraps"),
        skills: 1,
        agents: 0,
        installed: false,
      },
    ]);
    expect(claude.earlier).toEqual([]);
  });

  test("setup --status reads what the coding agent installed and changes nothing", async ({
    aireg,
    adapters: home,
    tmp,
  }) => {
    expect((await aireg(add("wraps", "deploy"), { cwd: tmp })).code).toBe(0);
    const env = await withClaude(home);
    await writeFile(join(home, "bin", "installed"), '{"id":"wraps@aireg"}');

    const status = await aireg(["targets", "setup", "--status"], { cwd: tmp, env });
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("wraps: 1 skill, 0 agents, installed");
    const calls = await readFile(join(home, "bin", "calls.log"), "utf8");
    expect(calls.trim()).toBe("plugin list --json");
  });
});
