import { describe, expect, it } from "vitest";
import type { LockArtifact } from "#core/lock.ts";
import type { Placement } from "#core/plan/model.ts";
import type { Scan } from "./scan.ts";
import { moved } from "./served.ts";

const row = {
  registry: "team",
  id: "skill_1",
  address: "artifacts/team/skill/probe",
  content: "sha256:before",
  version: "3",
} as LockArtifact;

function serving(placements: Placement[], entries: unknown[] = []): Scan {
  return {
    acquired: [
      {
        alias: "team",
        catalog: { entries },
        placements: new Map(placements.map((item) => [row.address, item])),
      },
    ],
  } as unknown as Scan;
}

const at = (contentId: string, version: string): Placement => ({
  id: "skill_1",
  name: "probe",
  contentId,
  version,
});

describe("moved", () => {
  it("is true once upstream serves something other than what the row recorded", () => {
    expect(moved(serving([at("sha256:after", "4")]), row)).toBe(true);
  });

  // A backend reviewing the upload still serves the old head, or nothing at all.
  it("is false while upstream serves the old head, or has nothing to serve", () => {
    expect(moved(serving([at("sha256:before", "3")]), row)).toBe(false);
    expect(moved(serving([]), row)).toBe(false);
    expect(moved(serving([at("sha256:after", "4")]), undefined)).toBe(false);
  });

  // Published with `--force` into a clone: upstream moved, but to a teammate's head, not ours.
  it("is false while upstream serves a version older than the one just sent", () => {
    const stale = { ...row, version: "0.1.0" };
    expect(moved(serving([at("sha256:after", "0.1.1")]), stale, "0.1.2")).toBe(false);
    expect(moved(serving([at("sha256:after", "0.1.2")]), stale, "0.1.2")).toBe(true);
  });

  it("finds a row of yours with no address yet where its publish put it", () => {
    const yours = {
      ...row,
      address: undefined,
      content: undefined,
      version: undefined,
      kind: "skill",
      name: "probe",
      namespace: "team",
      origin: { harness: "cursor", path: ".cursor/skills/probe", step: "origins" },
    } as LockArtifact;
    const listed = [{ kind: "skill", name: "probe", group: "team", path: row.address }];
    expect(moved(serving([at("sha256:after", "4")], listed), yours)).toBe(true);
    expect(moved(serving([at("sha256:after", "4")]), yours)).toBe(false);
  });
});
