import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { fileTest as test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

let root: string;

test.beforeAll(async ({ tmp }) => {
  root = join(tmp, "acme");
  await cp(ACME, root, { recursive: true });
});

test("points aireg mcp_server at its command, aireg mcp", async ({ aireg }) => {
  const result = await aireg(["mcp_server", "new", "weather"], { cwd: root });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("aireg mcp new");
});

describe("an MCP server in a registry that lists the kind", () => {
  const folder = (...rest: string[]) =>
    join(root, "artifacts", "engineering", "mcp_server", "weather", ...rest);
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

  test("starts from a server.json, not from the envelope's spec", async ({ aireg }) => {
    const engineering = join(root, "artifacts", "engineering");
    expect((await aireg(["mcp", "new", "weather", "-y"], { cwd: engineering })).code).toBe(0);

    expect(await json(folder("0.1.0", "server.json"))).toEqual({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "TODO",
      description: "TODO",
      version: "0.1.0",
    });
    const index = await aireg(["registry", "index"], { cwd: root });
    expect(index.code).not.toBe(0);
    expect(index.stderr).toContain("`server.name` is still TODO");
  });

  test("indexes it once filled in, and bumps it without editing server.json", async ({ aireg }) => {
    const server = await json(folder("0.1.0", "server.json"));
    const filled = { ...server, name: "com.example/weather", description: "Forecasts." };
    filled.remotes = [{ type: "streamable-http", url: "https://weather.example.com/mcp" }];
    await writeFile(folder("0.1.0", "server.json"), `${JSON.stringify(filled, undefined, 2)}\n`);
    expect((await aireg(["registry", "index"], { cwd: root })).code).toBe(0);

    const bump = ["mcp", "bump", "weather", "minor", "--namespace", "engineering"];
    expect((await aireg(bump, { cwd: root })).code).toBe(0);
    expect((await aireg(["registry", "index"], { cwd: root })).code).toBe(0);
    expect((await aireg(["registry", "validate"], { cwd: root })).code).toBe(0);

    expect(await readFile(folder("0.2.0", "server.json"))).toEqual(
      await readFile(folder("0.1.0", "server.json")),
    );
    const envelope = await json(folder("0.2.0", "artifact.json"));
    expect(envelope.metadata.version).toBe("0.2.0");
    expect(envelope.spec).toEqual({ name: "weather", description: "Forecasts.", server: filled });
  });
});

describe("an MCP server's catalog entry and import", () => {
  const issues = (...rest: string[]) =>
    join(root, "artifacts", "engineering", "mcp_server", "issue-tracker", "1.2.0", ...rest);
  const next = (...rest: string[]) =>
    join(root, "artifacts", "engineering", "mcp_server", "issue-tracker", "1.3.0", ...rest);

  test("takes its description and title from server.json, never from Markdown", async ({
    aireg,
  }) => {
    const bump = ["mcp", "bump", "issue-tracker", "minor", "--namespace", "engineering"];
    expect((await aireg(bump, { cwd: root })).code).toBe(0);
    await writeFile(next("README.md"), "---\nname: other\ndescription: From Markdown.\n---\n");
    expect((await aireg(["registry", "index"], { cwd: root })).code).toBe(0);

    const envelope = JSON.parse(await readFile(next("artifact.json"), "utf8"));
    expect(envelope.metadata).toMatchObject({
      description: "Search, read and update issues in the team's issue tracker.",
      display_name: "Issue tracker",
    });
    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    const entry = index.entries.find((row: { name: string }) => row.name === "issue-tracker");
    expect(entry.description).toBe("Search, read and update issues in the team's issue tracker.");
  });

  test("imports a README as it is, without reading front matter from it", async ({
    aireg,
    tmp,
  }) => {
    const source = join(tmp, "with-readme");
    await mkdir(source, { recursive: true });
    await cp(issues("server.json"), join(source, "server.json"));
    const readme = "---\nname: other\n---\n# Issues\n";
    await writeFile(join(source, "README.md"), readme);
    const engineering = join(root, "artifacts", "engineering");

    const args = ["mcp", "new", "--from", source, "--name", "imported", "-y"];
    expect((await aireg(args, { cwd: engineering })).code).toBe(0);

    const copied = join(engineering, "mcp_server", "imported", "0.1.0", "README.md");
    expect(await readFile(copied, "utf8")).toBe(readme);
  });

  test("refuses to import a server.json the MCP Registry schema rejects", async ({
    aireg,
    tmp,
  }) => {
    const source = join(tmp, "unnamed");
    await mkdir(source, { recursive: true });
    const server = JSON.parse(await readFile(issues("server.json"), "utf8"));
    await writeFile(join(source, "server.json"), JSON.stringify({ ...server, name: "issues" }));
    const engineering = join(root, "artifacts", "engineering");

    const result = await aireg(["mcp", "new", "--from", source, "-y"], { cwd: engineering });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("`server.name`");
  });

  test("refuses to import a folder without server.json, without asking for front matter", async ({
    aireg,
    tmp,
  }) => {
    const source = join(tmp, "readme-only");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Issues\n");
    const engineering = join(root, "artifacts", "engineering");

    const result = await aireg(["mcp", "new", "--from", source, "-y"], { cwd: engineering });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("has no server.json.");
    expect(result.stderr).not.toContain("front matter");
  });
});
