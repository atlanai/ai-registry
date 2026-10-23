import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { test as base } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";

const SKILL = "---\nname: lint\ndescription: Lints.\n---\nrun\n";
const AGENT = "---\nname: helper\ndescription: Helps.\n---\nhelp\n";

function artifact(kind: string, name: string, path: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return [
    `{ id: '${kind}_${name}', kind: '${kind}', group: 'team', envelope: {`,
    `  apiVersion: 'aireg.sh/v1', kind: '${kind}',`,
    `  metadata: { name: '${name}', namespace: 'team', version: '1.0.0', description: 'Ships.' },`,
    `  files: [{ path: '${path}', digest: 'sha256:${digest}', size: ${Buffer.byteLength(body)},`,
    "    media_type: 'text/markdown', urls: ['x'] }] },",
    `  files: [{ path: '${path}', locator: '${kind}', executable: false }] }`,
  ].join("\n");
}

// Once `deleted` exists the agent is gone; the file says whether the listing claims to be complete.
function adapterSource(flag: string): string {
  return [
    "import { existsSync, readFileSync } from 'node:fs';",
    `const skill = ${artifact("skill", "lint", "SKILL.md", SKILL)};`,
    `const agent = ${artifact("agent", "helper", "AGENT.md", AGENT)};`,
    `const bodies = { skill: ${JSON.stringify(SKILL)}, agent: ${JSON.stringify(AGENT)} };`,
    `const flag = ${JSON.stringify(flag)};`,
    "export default {",
    "  id: 'drops', displayName: 'drops', protocol: 1, artifactKinds: ['skill', 'agent'],",
    "  dispatch: { hosts: ['drops.example'] },",
    "  capabilities: { pinsSource: false, agentFolders: true },",
    "  connect: async () => ({",
    "    resolve: async (_want, options) => !existsSync(flag)",
    "      ? { artifacts: [skill, agent] }",
    "      : { artifacts: [skill],",
    "          complete: options?.all === true && readFileSync(flag, 'utf8') === 'complete' },",
    "    fetch: async (_artifact, file) => new TextEncoder().encode(bodies[file.locator]),",
    "    close: async () => {},",
    "  }),",
    "};",
    "",
  ].join("\n");
}

const test = base.extend("flag", async ({ home: { dir: home } }) => {
  const flag = join(home, "deleted");
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "drops.mjs"), adapterSource(flag));
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
  return flag;
});

async function lockedNames(project: string): Promise<string[]> {
  const lock = parse(await readFile(lockPath(project), "utf8")) as {
    artifacts: Record<string, unknown>;
  };
  return Object.keys(lock.artifacts).sort();
}

async function installWhole(aireg: (args: string[]) => Promise<{ code: number; stderr: string }>) {
  expect((await aireg(["init", "-y", "--for", "claude"])).code).toBe(0);
  const added = await aireg(["add", "https://drops.example", "--adapter", "drops", "-y"]);
  expect(added.code, added.stderr).toBe(0);
}

describe("an artifact deleted from a registry installed whole", () => {
  test("is removed when the adapter read its listing to the end", async ({
    aireg,
    project,
    flag,
  }) => {
    await installWhole(aireg);
    const agent = join(project, ".claude", "agents", "helper.md");
    expect(existsSync(agent)).toBe(true);

    await writeFile(flag, "complete");
    const synced = await aireg(["sync", "-y"]);
    expect(synced.code, synced.stderr).toBe(0);
    expect(synced.stderr).not.toContain("no longer lists");
    expect(await lockedNames(project)).toEqual(["team/lint"]);
    expect(existsSync(agent)).toBe(false);

    const again = await aireg(["update", "-y"]);
    expect(again.code, again.stderr).toBe(0);
  }, 60_000);

  test("is kept when the listing does not say it is complete", async ({ aireg, project, flag }) => {
    await installWhole(aireg);

    await writeFile(flag, "partial");
    const synced = await aireg(["sync", "-y"]);
    expect(synced.code).toBe(3);
    expect(`${synced.stdout}${synced.stderr}`).toContain("drops no longer lists it");
    expect(await lockedNames(project)).toEqual(["team/helper", "team/lint"]);
    expect(existsSync(join(project, ".claude", "agents", "helper.md"))).toBe(true);
  }, 60_000);
});
