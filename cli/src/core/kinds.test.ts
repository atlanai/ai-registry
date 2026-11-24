import { describe, expect, test } from "vitest";
import { KINDS } from "#adapter/kinds.ts";
import { aKind, KIND_SPECS, kindDir, SCANNED_KINDS, stagedLeaf } from "./kinds.ts";

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
});

describe("stagedLeaf", () => {
  test("gives a directory-shaped kind a bare name", () => {
    expect(stagedLeaf("skill", "api-design", "plugins/acme-api/skills/api-design")).toBe(
      "api-design",
    );
    expect(stagedLeaf("plugin", "acme-core", "plugins/acme-core")).toBe("acme-core");
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

describe("mcp_server", () => {
  test("is never scanned for in a target folder", () => {
    expect(SCANNED_KINDS).not.toContain("mcp_server");
    expect(SCANNED_KINDS).toEqual(["skill", "agent"]);
  });

  test("keeps server.json as the entry of its staged folder", () => {
    expect(KIND_SPECS.mcp_server).toMatchObject({ shape: "directory", entry: "server.json" });
  });

  test("takes an before it, as agent does", () => {
    expect(aKind("mcp_server")).toBe("an MCP server");
    expect(aKind("agent")).toBe("an agent");
    expect(aKind("skill")).toBe("a skill");
  });
});
