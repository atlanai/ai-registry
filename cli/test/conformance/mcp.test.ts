import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { SCOPE_DIR } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

/** Where each target reads an MCP server, as its EVIDENCE.md records; undefined where it cannot. */
const PLACES: Record<string, { project?: string; user?: string; key: string }> = {
  "claude-code": { project: ".mcp.json", key: "mcpServers" },
  "github-copilot": {
    project: ".mcp.json",
    user: ".copilot/mcp-config.json",
    key: "mcpServers",
  },
  codex: { project: ".codex/config.toml", user: ".codex/config.toml", key: "mcp_servers" },
  cursor: { project: ".cursor/mcp.json", user: ".cursor/mcp.json", key: "mcpServers" },
  "gemini-cli": {
    project: ".gemini/settings.json",
    user: ".gemini/settings.json",
    key: "mcpServers",
  },
  opencode: { project: "opencode.json", user: ".config/opencode/opencode.json", key: "mcp" },
  grok: { project: ".grok/config.toml", user: ".grok/config.toml", key: "mcp_servers" },
  pi: { project: ".pi/mcp.json", user: ".pi/agent/mcp.json", key: "mcpServers" },
  "hermes-agent": { user: ".hermes/config.yaml", key: "mcp_servers" },
};

const MANIFEST = (target: string, registry: string) =>
  [
    `targets: [${target}]`,
    "registries:",
    `  acme: ${registry}`,
    "artifacts:",
    "  - ref: acme/engineering/issue-tracker",
    "    with: { ISSUES_URL: https://issues.example.test }",
    "",
  ].join("\n");

const CASES = Object.entries(PLACES).flatMap(([target, place]) =>
  (["project", "user"] as const).map((scope) => ({ target, scope, file: place[scope], place })),
);

test.for(CASES)(
  "$target at $scope scope: $file",
  async ({ target, scope, file, place }, { aireg, git, home, project, tmp }) => {
    const registry = join(tmp, "acme");
    await cp(ACME, registry, { recursive: true });
    const user = scope === "user";
    const base = user ? home.dir : project;
    const flags = user ? ["-g"] : [];
    await git.init(project);
    await mkdir(join(base, SCOPE_DIR), { recursive: true });
    await writeFile(join(base, SCOPE_DIR, "manifest.yml"), MANIFEST(target, registry));
    const ran = await aireg(["install", ...flags], { cwd: project });
    expect(ran.code, ran.stderr).toBe(0);
    const path = join(base, file ?? "none");
    const text = existsSync(path) ? await readFile(path, "utf8") : "";
    // Where the target reads no server, nothing is written and the server is not installed.
    expect(text.includes(place.key) && text.includes("@example/issue-tracker-mcp@1.2.0")).toBe(
      file !== undefined,
    );
    expect((await aireg(["remove", "issue-tracker", "-y", ...flags], { cwd: project })).code).toBe(
      0,
    );
    const after = existsSync(path) ? await readFile(path, "utf8") : "";
    expect(after).not.toContain("issue-tracker");
  },
);
