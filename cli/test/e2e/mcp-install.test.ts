import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { fileTest as test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

test("installs an MCP server into Claude Code's .mcp.json, sees an edit, and removes it", async ({
  aireg,
  git,
  project,
  tmp,
}) => {
  const registry = join(tmp, "acme");
  await cp(ACME, registry, { recursive: true });
  await git.init(project);
  await mkdir(join(project, ".registry"));
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    [
      "targets: [claude-code]",
      "registries:",
      `  acme: ${registry}`,
      "artifacts:",
      "  - ref: acme/engineering/issue-tracker",
      "    with: { ISSUES_URL: https://issues.example.test }",
      "",
    ].join("\n"),
  );
  const mcp = join(project, ".mcp.json");
  await writeFile(mcp, JSON.stringify({ mcpServers: { mine: { command: "mine" } } }));

  const installed = await aireg(["install"], { cwd: project });
  expect(installed.code).toBe(0);
  expect(installed.stdout).toContain("Installed issue-tracker for Claude Code.");
  expect(installed.stderr).not.toContain("installed into no target");
  const written = JSON.parse(await readFile(mcp, "utf8"));
  expect(written.mcpServers).toEqual({
    mine: { command: "mine" },
    "issue-tracker": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@example/issue-tracker-mcp@1.2.0"],
      env: { ISSUES_URL: "https://issues.example.test", ISSUES_TOKEN: `\${ISSUES_TOKEN}` },
    },
  });
  const lock = await readFile(join(project, ".registry", "manifest.lock.yml"), "utf8");
  expect(lock).toContain("version: 2\n");
  expect(lock).toContain("file: .mcp.json");

  written.mcpServers["issue-tracker"].args.push("--verbose");
  await writeFile(mcp, JSON.stringify(written));
  const status = await aireg(["status"], { cwd: project });
  expect(status.code).not.toBe(0);
  expect(status.stdout).toContain("its entry in .mcp.json was edited after installation");

  written.mcpServers["issue-tracker"].args.pop();
  await writeFile(mcp, JSON.stringify(written));
  expect((await aireg(["remove", "issue-tracker", "-y"], { cwd: project })).code).toBe(0);
  expect(JSON.parse(await readFile(mcp, "utf8"))).toEqual({
    mcpServers: { mine: { command: "mine" } },
  });
  expect(existsSync(join(project, ".claude"))).toBe(false);
});

test("shows how an MCP server starts, and what it reads", async ({ aireg, tmp }) => {
  const registry = join(tmp, "shown");
  await cp(ACME, registry, { recursive: true });
  const shown = await aireg(["show", "engineering/issue-tracker", "--registry", registry]);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain("runs   npx -y @example/issue-tracker-mcp@1.2.0");
  expect(shown.stdout).toContain(
    "runs   https://<tenant>.issues.example.com/mcp (streamable-http)",
  );
  expect(shown.stdout).toContain("reads  ISSUES_TOKEN, TOKEN");
  const json = JSON.parse(
    (await aireg(["show", "engineering/issue-tracker", "--registry", registry, "--json"])).stdout,
  );
  expect(json.data.server.reads).toEqual(["ISSUES_TOKEN", "TOKEN"]);
});

test("adds a namespace's MCP servers only with --yes when it cannot ask", async ({
  aireg,
  git,
  tmp,
}) => {
  const project = join(tmp, "namespace");
  const registry = join(tmp, "namespace-acme");
  await cp(ACME, registry, { recursive: true });
  await mkdir(join(project, ".registry"), { recursive: true });
  await git.init(project);
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    `targets: [claude-code]\nregistries:\n  acme: ${registry}\n`,
  );
  const refused = await aireg(["add", "acme/engineering"], { cwd: project });
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain(
    '"issue-tracker" is an MCP server, which a target starts as you.',
  );
  expect(existsSync(join(project, ".claude"))).toBe(false);

  const added = await aireg(["add", "acme/engineering", "-y"], { cwd: project });
  expect(added.code).toBe(0);
  expect(added.stderr).toContain('it needs "tenant", which nothing sets');
});

test("installs an MCP server for every project target that loads one, and removes it", async ({
  aireg,
  git,
  tmp,
}) => {
  const project = join(tmp, "every-project");
  const registry = join(tmp, "every");
  await cp(ACME, registry, { recursive: true });
  await mkdir(join(project, ".registry"), { recursive: true });
  await git.init(project);
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    [
      "targets: [claude-code, github-copilot, codex, cursor, gemini-cli, opencode, grok, pi, antigravity]",
      "registries:",
      `  acme: ${registry}`,
      "artifacts:",
      "  - ref: acme/engineering/issue-tracker",
      "    with: { ISSUES_URL: https://issues.example.test }",
      "",
    ].join("\n"),
  );
  const mine: Record<string, string> = {
    ".gemini/settings.json": '{\n  "theme": "dark"\n}\n',
    ".codex/config.toml": 'model = "o4"\n',
  };
  for (const [file, text] of Object.entries(mine)) {
    await mkdir(join(project, file, ".."), { recursive: true });
    await writeFile(join(project, file), text);
  }
  const read = async (file: string) => readFile(join(project, file), "utf8");

  const installed = await aireg(["install"], { cwd: project });
  expect(installed.code, installed.stderr).toBe(0);
  expect(installed.stderr).toContain(
    "Did not install issue-tracker for Google Antigravity: it reads MCP servers only from your user scope",
  );
  const token = "ISSUES_TOKEN";
  const args = ["-y", "@example/issue-tracker-mcp@1.2.0"];
  const url = "https://issues.example.test";
  const shared = { command: "npx", args, env: { ISSUES_URL: url, [token]: `\${${token}}` } };
  const typed = { type: "stdio", ...shared };
  expect(JSON.parse(await read(".mcp.json")).mcpServers["issue-tracker"]).toEqual(typed);
  expect(JSON.parse(await read(".cursor/mcp.json")).mcpServers["issue-tracker"]).toEqual({
    ...typed,
    env: { ISSUES_URL: url, [token]: `\${env:${token}}` },
  });
  expect(JSON.parse(await read(".gemini/settings.json"))).toEqual({
    theme: "dark",
    mcpServers: { "issue-tracker": shared },
  });
  expect(JSON.parse(await read(".pi/mcp.json")).mcpServers["issue-tracker"]).toEqual(shared);
  expect(JSON.parse(await read("opencode.json")).mcp["issue-tracker"]).toEqual({
    type: "local",
    command: ["npx", ...args],
    environment: { ISSUES_URL: url, [token]: `{env:${token}}` },
  });
  const codex = await read(".codex/config.toml");
  expect(codex).toContain('model = "o4"');
  expect(codex).toContain(`env_vars = ["${token}"]`);
  expect(await read(".grok/config.toml")).toContain(`${token} = "\${${token}}"`);

  const status = await aireg(["status"], { cwd: project });
  expect(status.code, status.stdout).toBe(0);

  // Claude Code and Copilot share the entry, so dropping one target leaves it for the other.
  const manifest = join(project, ".registry", "manifest.yml");
  await writeFile(manifest, (await readFile(manifest, "utf8")).replace("claude-code, ", ""));
  expect((await aireg(["install"], { cwd: project })).code).toBe(0);
  expect(JSON.parse(await read(".mcp.json")).mcpServers["issue-tracker"]).toEqual(typed);

  expect((await aireg(["remove", "issue-tracker", "-y"], { cwd: project })).code).toBe(0);
  for (const [file, text] of Object.entries(mine)) expect(await read(file)).toBe(text);
  for (const file of [".mcp.json", ".cursor/mcp.json", ".pi/mcp.json", "opencode.json"]) {
    expect(existsSync(join(project, file)), file).toBe(false);
  }
  for (const folder of [".cursor", ".grok", ".pi"]) {
    expect(existsSync(join(project, folder)), folder).toBe(false);
  }
});
