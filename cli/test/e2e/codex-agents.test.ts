import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";

// Codex reads agents only as TOML, so each one is written there as a file of its own.

let aireg: Aireg;
let project: string;
let home: string;

const AGENT = [
  "---",
  "name: reviewer",
  "description: Reviews pull requests.",
  "tools: Read, Grep",
  "model: sonnet",
  "color: cyan",
  "---",
  "",
  'Say "hi" and check C:\\temp first.',
  "",
].join("\n");

const TOML = [
  'name = "reviewer"',
  'description = "Reviews pull requests."',
  'developer_instructions = """',
  'Say "hi" and check C:\\\\temp first."""',
  "",
].join("\n");

const toml = () => join(project, ".codex", "agents", "reviewer.toml");

test.beforeAll(async ({ aireg: run, tmp, project: dir, home: { dir: homeDir } }) => {
  [aireg, project, home] = [run, dir, homeDir];
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .agent("eng/reviewer@1.0.0", { files: { "AGENT.md": AGENT } })
    .write();
  await mkdir(join(project, ".claude"), { recursive: true });
  expect((await aireg(["init", "-y", "--for", "claude-code,codex"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme", "-g"])).code).toBe(0);
});

describe("an agent installed for Codex", () => {
  test("is written as TOML holding only what Codex reads", async () => {
    const added = await aireg(["add", "acme/eng/agent/reviewer", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect((await lstat(toml())).isFile()).toBe(true);
    expect(await readFile(toml(), "utf8")).toBe(TOML);
    expect(`${added.stdout}${added.stderr}`).not.toContain("skips");
    const status = await aireg(["status"]);
    expect(status.code, status.stdout).toBe(0);
    expect(status.stdout).toMatch(/reviewer +agent +1\.0\.0 +acme +✓ +✓ +ok/);
  });

  test("is seen as edited, kept by update, and restored by install --force", async () => {
    await appendFile(toml(), "# mine\n");
    const status = await aireg(["status"]);
    expect(status.code).toBe(3);
    expect(status.stdout).toMatch(/reviewer .* edited +its copy was edited after installation/);
    expect(`${status.stdout}${status.stderr}`).toContain("run `aireg install --force`");
    const updated = await aireg(["update", "-y"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stderr).toContain(
      "was edited after installation in .codex/agents/reviewer.toml",
    );
    expect(await readFile(toml(), "utf8")).toBe(`${TOML}# mine
`);
    expect((await aireg(["install", "--force", "-y"])).code).toBe(0);
    expect(await readFile(toml(), "utf8")).toBe(TOML);
    expect((await aireg(["status"])).code).toBe(0);
  });

  test("goes to the Codex home in your user scope", async () => {
    expect(
      (await aireg(["add", "acme/eng/agent/reviewer", "-g", "-y", "--for", "codex"])).code,
    ).toBe(0);
    expect(await readFile(join(home, ".codex", "agents", "reviewer.toml"), "utf8")).toBe(TOML);
  });
});
