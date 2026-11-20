import { describe, expect, test } from "vitest";
import { KINDS } from "#adapter/kinds.ts";
import { KIND_SPECS, kindDir, stagedLeaf } from "./kinds.ts";

describe("KIND_SPECS", () => {
  test("gives every kind a distinct directory", () => {
    const dirs = KINDS.map(kindDir);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  test("requires an extension for every file-shaped kind", () => {
    for (const kind of KINDS) {
      const spec = KIND_SPECS[kind];
      expect(spec.extensions.length > 0, kind).toBe(spec.shape === "file");
    }
  });

  test("configures mcp_server as a directory kind with mcp.json entry", () => {
    expect(KINDS).toContain("mcp_server");
    const spec = KIND_SPECS.mcp_server;
    expect(spec.shape).toBe("directory");
    expect(spec.dir).toBe("mcp-servers");
    expect(spec.entry).toBe("mcp.json");
    expect(spec.extensions).toEqual([]);
  });
});

describe("stagedLeaf", () => {
  test("gives a directory-shaped kind a bare name", () => {
    expect(stagedLeaf("skill", "api-design", "plugins/acme-api/skills/api-design")).toBe(
      "api-design",
    );
    expect(stagedLeaf("plugin", "acme-core", "plugins/acme-core")).toBe("acme-core");
    expect(stagedLeaf("mcp_server", "postgres-mcp", "mcp-servers/postgres-mcp")).toBe("postgres-mcp");
  });

  test("keeps the extension the source actually used", () => {
    expect(stagedLeaf("agent", "reviewer", "agents/reviewer.md")).toBe("reviewer.md");
    expect(stagedLeaf("agent", "style", "agents/style.mdc")).toBe("style.mdc");
  });

  test("takes the stem from the name, not the filename", () => {
    // Front matter renames the artifact, and the staged path follows the address.
    expect(stagedLeaf("agent", "reviewer", "agents/doctor.md")).toBe("reviewer.md");
  });

  test("never lets a directory name with a dot grow a false extension", () => {
    expect(stagedLeaf("skill", "v1.2", "skills/v1.2")).toBe("v1.2");
  });

  test("drops anything that is not a plain extension", () => {
    expect(stagedLeaf("agent", "odd", "agents/odd.")).toBe("odd");
    expect(stagedLeaf("agent", "odd", "agents/odd")).toBe("odd");
    expect(stagedLeaf("agent", "odd", "agents/odd.a-b")).toBe("odd");
  });
});
