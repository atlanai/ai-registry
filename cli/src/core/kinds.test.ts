import { describe, expect, test } from "vitest";
import { KINDS } from "#adapter/kinds.ts";
import { kindDir, kindPlural, kindSpec, stagedLeaf } from "./kinds.ts";

describe("kindSpec", () => {
  test("gives every kind a distinct directory", () => {
    const dirs = KINDS.map(kindDir);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  test("requires an extension for every file-shaped kind", () => {
    for (const kind of KINDS) {
      const spec = kindSpec(kind);
      expect(spec?.extensions.length !== 0, kind).toBe(spec?.shape === "file");
    }
  });

  test("knows no kind outside the built-ins and declared ones, and never guesses its folder", () => {
    expect(kindSpec("knowledge")).toBeUndefined();
    expect(kindSpec("toString")).toBeUndefined();
    expect(kindPlural("knowledge")).toBe("knowledge artifacts");
    expect(kindPlural("agent")).toBe("agents");
    expect(() => kindDir("knowledge")).toThrow('aireg does not know the kind "knowledge".');
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
