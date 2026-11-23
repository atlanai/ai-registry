import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";

let aireg: Aireg;
let project: string;
let home: string;

const AGENT = [
  "---",
  "name: reviewer",
  "description: Reviews pull requests.",
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

const LIMITED = [
  "---",
  "name: auditor",
  "description: Reads code and never edits it.",
  "tools: Read, Grep",
  "---",
  "",
  "Audit the change.",
  "",
].join("\n");

const toml = () => join(project, ".codex", "agents", "reviewer.toml");

test.beforeAll(async ({ aireg: run, tmp, project: dir, home: { dir: homeDir } }) => {
  [aireg, project, home] = [run, dir, homeDir];
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .agent("eng/reviewer@1.0.0", { files: { "AGENT.md": AGENT } })
    .agent("eng/auditor@1.0.0", { files: { "AGENT.md": LIMITED } })
    .write();
  await mkdir(join(project, ".claude"), { recursive: true });
  expect((await aireg(["init", "-y", "--for", "claude-code,codex"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme", "-g"])).code).toBe(0);
});

// Codex reads agents only as TOML, so each one is written there as a file of its own.
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

  test("is left out when it sets a key Codex cannot read that limits it", async () => {
    const added = await aireg(["add", "acme/eng/agent/auditor", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(
      "Did not install auditor for Codex: it sets tools, which this target cannot read.",
    );
    await expect(lstat(join(project, ".codex", "agents", "auditor.toml"))).rejects.toThrow();
    expect(await readFile(join(project, ".claude", "agents", "auditor.md"), "utf8")).toBe(LIMITED);
  });

  test("is removed from Codex when an update gives it such a key", async ({ tmp }) => {
    const market = join(tmp, "limits");
    const narrowed = LIMITED.replace("auditor", "narrowed");
    const publish = (versions: Record<string, string>) => {
      const built = registry(market, { name: "limits", slug: "limits" });
      for (const [version, text] of Object.entries(versions))
        built.agent(`eng/narrowed@${version}`, { files: { "AGENT.md": text } });
      return built.write();
    };
    const plain = narrowed.replace("tools: Read, Grep\n", "");
    await publish({ "1.0.0": plain });
    expect((await aireg(["registry", "add", market, "--as", "limits"])).code).toBe(0);
    expect((await aireg(["add", "limits/eng/agent/narrowed", "-y"])).code).toBe(0);
    const written = join(project, ".codex", "agents", "narrowed.toml");
    expect((await lstat(written)).isFile()).toBe(true);

    await publish({ "1.0.0": plain, "1.1.0": narrowed });
    const updated = await aireg(["update", "-y"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stderr).toContain("Did not install narrowed for Codex: it sets tools");
    expect(`${updated.stdout}${updated.stderr}`).not.toMatch(/(Restored|Updated) .*Codex/);
    await expect(lstat(written)).rejects.toThrow();
    expect(await readFile(join(project, ".claude", "agents", "narrowed.md"), "utf8")).toBe(
      narrowed,
    );
    const status = await aireg(["status"]);
    expect(status.code, status.stdout).toBe(0);
  });
});
