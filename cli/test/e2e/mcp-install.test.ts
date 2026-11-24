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
      command: "npx",
      args: ["-y", "@example/issue-tracker-mcp@1.2.0"],
      env: { ISSUES_URL: "https://issues.example.test", ISSUES_TOKEN: "${ISSUES_TOKEN}" },
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
