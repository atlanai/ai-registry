import { describe, expect, test } from "vitest";
import { roots } from "#core/store/paths.ts";
import {
  type ActionOf,
  addCloned,
  addLinked,
  addStaging,
  addUnlinked,
  linkKey,
  type Run,
  startRun,
} from "./run.ts";

const link: ActionOf<"link"> = {
  kind: "link",
  name: "lint",
  target: "claude-code",
  from: "/work/.registry/artifacts/lint",
  to: "/work/.claude/skills/lint",
  copy: false,
};

const backedUp = { path: link.to, to: "/backups/lint", what: "folder" as const };

function fresh(): Run {
  const inputs = {
    roots: roots("project", "/work"),
    env: process.env,
    ahead: () => Promise.reject(new Error("no fetch")),
    before: undefined,
    stamp: () => "20260101T000000Z",
  };
  return startRun(inputs, new Map([[link.to, "backup"]]));
}

describe("addLinked", () => {
  test("leaves a link not made out of the lock and keeps what it reported", () => {
    const { results } = fresh();
    addLinked(results, link, { kept: { name: "lint", path: link.to } });
    expect(results.skipped).toEqual(new Set([linkKey("lint", link.to)]));
    expect(results.kept).toEqual([{ name: "lint", path: link.to }]);
    expect(results.performed.link).toBe(0);
  });

  test("settles a path it moved a person's file away from, made or not", () => {
    const { results } = fresh();
    addLinked(results, link, { backedUp });
    expect(results.backedUp).toEqual([backedUp]);
    expect(results.guards.get(link.to)).toBe("replace");
  });

  test("records a made copy's mode, digest and degraded target", () => {
    const { results } = fresh();
    addLinked(results, link, { made: { mode: "copy", digest: "sha256:1", degraded: true } });
    expect(results.modes.get(linkKey("lint", link.to))).toBe("copy");
    expect(results.pathModes.get(link.to)).toBe("copy");
    expect(results.copies.get(link.to)).toBe("sha256:1");
    expect(results.degraded).toEqual(new Set(["claude-code"]));
    expect(results.installed).toEqual(new Set(["lint"]));
    expect(results.performed.link).toBe(1);
  });
});

describe("the other steps", () => {
  test("a stage that failed counts nothing and says why", () => {
    const { results } = fresh();
    const error = new Error("gone");
    addStaging(results, "lint", {
      staged: undefined,
      unstaged: [["lint", { reason: "gone", error }]],
    });
    expect(results.unstaged.get("lint")).toEqual({ reason: "gone", error });
    expect(results.performed.stage).toBe(0);
  });

  test("a clone of nothing staged is skipped, and only a first copy sets a digest", () => {
    const { results } = fresh();
    const clone: ActionOf<"clone"> = { kind: "clone", name: "lint", from: "", to: "/work/copy" };
    addCloned(results, clone, { cloned: false });
    addCloned(results, clone, { cloned: true, digest: "sha256:1" });
    addCloned(results, clone, { cloned: true, digest: undefined });
    expect(results.skipped).toEqual(new Set([linkKey("lint", "/work/copy")]));
    expect(results.digests.get("lint")).toBe("sha256:1");
    expect(results.performed.clone).toBe(2);
  });

  test("an unlink counts whether or not it backed something up", () => {
    const { results } = fresh();
    addUnlinked(results, backedUp);
    addUnlinked(results, undefined);
    expect(results.backedUp).toEqual([backedUp]);
    expect(results.guards.get(link.to)).toBe("backup");
    expect(results.performed.unlink).toBe(2);
  });
});
