import { describe, expect, test } from "vitest";
import { artifactAt } from "./names.ts";

describe("artifactAt", () => {
  test("reads an artifact folder at the registry's root", () => {
    expect(artifactAt("artifacts/engineering/skill/pr-review")).toEqual({
      root: "",
      namespace: "engineering",
      kind: "skill",
      name: "pr-review",
      version: undefined,
    });
  });

  test("reads a version folder, and a file inside one", () => {
    const at = { root: "", namespace: "engineering", kind: "skill", name: "pr-review" };
    expect(artifactAt("artifacts/engineering/skill/pr-review/1.2.0")).toEqual({
      ...at,
      version: "1.2.0",
    });
    expect(artifactAt("artifacts/engineering/skill/pr-review/1.2.0/SKILL.md/")).toEqual({
      ...at,
      version: "1.2.0",
    });
    expect(artifactAt("artifacts/engineering/skill/pr-review/versions.json")).toEqual({
      ...at,
      version: undefined,
    });
  });

  test("names the folder above artifacts as the registry's", () => {
    expect(artifactAt("examples/acme/artifacts/engineering/agent/reviewer")).toMatchObject({
      root: "examples/acme",
      kind: "agent",
      name: "reviewer",
    });
  });

  test("tells a namespace called artifacts from the registry's own folder", () => {
    expect(artifactAt("artifacts/artifacts/skill/lint")).toMatchObject({
      root: "",
      namespace: "artifacts",
      name: "lint",
    });
  });

  test("finds nothing where the path stops short of an artifact", () => {
    expect(artifactAt("")).toBeUndefined();
    expect(artifactAt("examples/acme")).toBeUndefined();
    expect(artifactAt("artifacts/engineering/skill")).toBeUndefined();
    expect(artifactAt("artifacts/Engineering/skill/pr-review")).toBeUndefined();
  });
});
