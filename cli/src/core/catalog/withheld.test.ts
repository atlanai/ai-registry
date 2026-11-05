import { describe, expect, test } from "vitest";
import {
  countPast,
  newestFrom,
  statusWarning,
  withheldAt,
  withheldFrom,
  withheldMessage,
} from "./withheld.ts";

describe("what a registry withholds", () => {
  test("drops what it cannot name, and shows a reason without its escapes", () => {
    const withheld = withheldFrom([
      {
        name: "gate",
        namespace: "ops",
        kind: "skill",
        version: "1.1.0",
        status: "blocked",
        reason: "x\u001B]0;t\u0007y",
      },
      { name: "gate", kind: "tool", version: "1.0.0", status: "blocked" },
      { kind: "skill", version: "1.0.0", status: "blocked" },
    ]);
    expect(withheld).toHaveLength(1);
    expect(withheldMessage(withheld[0] as (typeof withheld)[number])).toBe(
      "ops/gate 1.1.0 is blocked (xy)",
    );
  });

  test("is found by the address that reaches it", () => {
    const withheld = withheldFrom([
      { name: "sketch", namespace: "ops", kind: "skill", version: "0.1.0", status: "draft" },
    ]);
    expect(withheldAt(withheld, { name: "sketch" })?.status).toBe("draft");
    expect(withheldAt(withheld, { name: "sketch", group: "data" })).toBeUndefined();
    expect(withheldAt(withheld, { name: "sketch", kind: "agent" })).toBeUndefined();
  });
});

describe("statusWarning", () => {
  const at = { name: "lint", group: "ops", kind: "skill" as const, version: "1.1.0" };
  test("names a deprecated version and why", () => {
    expect(statusWarning({ ...at, status: "deprecated", reason: "use fmt" })).toBe(
      "ops/lint 1.1.0 is deprecated (use fmt).",
    );
  });

  test("says a draft installs only because it was pinned", () => {
    expect(statusWarning({ ...at, status: "pending_review", reason: undefined })).toBe(
      "ops/lint 1.1.0 is pending review, and installs only because it is pinned.",
    );
  });
});

describe("countPast", () => {
  const lint = { name: "lint", group: "ops", kind: "skill" as const };
  const newest = newestFrom([
    { name: "lint", namespace: "ops", kind: "skill", version: "0.1.1" },
    { name: "lint", namespace: "data", kind: "skill", version: "9.0.0" },
    { name: "lint", kind: "tool", version: "9.0.0" },
  ]);

  test("counts from a newer version the registry holds, such as a yanked one", () => {
    expect(countPast("0.1.0", newest, lint)).toBe("0.1.1");
    expect(countPast(undefined, newest, lint)).toBe("0.1.1");
  });

  test("keeps the version when nothing it holds is newer, or names another artifact", () => {
    expect(countPast("0.2.0", newest, lint)).toBe("0.2.0");
    expect(countPast("0.1.0", newest, { ...lint, kind: "agent" })).toBe("0.1.0");
    expect(countPast("0.1.0", undefined, lint)).toBe("0.1.0");
    // Not SemVer, so the caller refuses it rather than counting from what it cannot order.
    expect(countPast("1", newest, lint)).toBe("1");
  });
});
