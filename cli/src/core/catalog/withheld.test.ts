import { describe, expect, it } from "vitest";
import { statusWarning, withheldAt, withheldFrom, withheldMessage } from "./withheld.ts";

describe("what a registry withholds", () => {
  it("drops what it cannot name, and shows a reason without its escapes", () => {
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

  it("is found by the address that reaches it", () => {
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
  it("names a deprecated version and why", () => {
    expect(statusWarning({ ...at, status: "deprecated", reason: "use fmt" })).toBe(
      "ops/lint 1.1.0 is deprecated (use fmt).",
    );
  });

  it("says a draft installs only because it was pinned", () => {
    expect(statusWarning({ ...at, status: "pending_review", reason: undefined })).toBe(
      "ops/lint 1.1.0 is pending review, and installs only because it is pinned.",
    );
  });
});
