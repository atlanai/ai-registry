import { describe, expect, test } from "vitest";
import { resolveVersion, SpecError, type VersionsDocument } from "./documents.ts";

const row = (version: string, yanked = false) => ({
  version,
  digest: `sha256:${version}`,
  status: undefined,
  yanked,
  reason: undefined,
});

const lint: VersionsDocument = {
  namespace: "engineering",
  kind: "skill",
  name: "lint",
  latest: "0.3.0",
  versions: [row("0.3.0"), row("0.2.0", true), row("0.1.0")],
};

describe("resolveVersion", () => {
  test("takes latest when no version is asked for", () => {
    expect(resolveVersion(lint, undefined).version).toBe("0.3.0");
  });

  test("calls a version that was never released missing, and names the ones there are", () => {
    let thrown: unknown;
    try {
      resolveVersion(lint, "9.9.9");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SpecError);
    expect(thrown).toMatchObject({
      message: "engineering/lint has no version 9.9.9.",
      code: "not_found",
      artifact: "engineering/lint",
      hint: "Use 0.3.0 or 0.1.0.",
    });
  });

  test("counts the versions it does not name", () => {
    const many = { ...lint, versions: ["7", "6", "5", "4", "3", "2"].map((v) => row(`0.${v}.0`)) };
    expect(() => resolveVersion(many, "9.9.9")).toThrow(
      expect.objectContaining({
        hint: "Use 0.7.0, 0.6.0, 0.5.0, 0.4.0 or 0.3.0, or another of its 6 versions.",
      }),
    );
  });
});
