import { describe, expect, test } from "vitest";
import type { Candidate } from "#core/sync/adopt.ts";
import type { SyncItem } from "#core/sync/model.ts";
import { artifactKey } from "./decide.ts";
import { RunScopeError, scopedKeys } from "./narrow.ts";
import type { Scan } from "./scan.ts";

const REGISTRY = "shop";

function item(name: string, kind: SyncItem["kind"] = "skill", source = REGISTRY): SyncItem {
  return { name, kind, source, path: name } as unknown as SyncItem;
}

function candidate(name: string, kind: Candidate["kind"] = "skill"): Candidate {
  return { name, kind } as unknown as Candidate;
}

function scanOf(items: SyncItem[], local: Candidate[] = []): Scan {
  return { items, local, undeclared: [] } as unknown as Scan;
}

const catalog = scanOf(
  [
    item("sales/deploy"),
    item("sales/lint"),
    item("engineering/lint"),
    item("engineering/lint", "agent"),
    item("loose"),
    item("other/deploy", "skill", "elsewhere"),
  ],
  [candidate("written-here")],
);

describe("scopedKeys", () => {
  test("covers everything the job does when no refs were asked for", () => {
    expect(scopedKeys(undefined, catalog, REGISTRY)).toBeUndefined();
  });

  test.each([
    ["the catalog name", "sales/deploy", [artifactKey("skill", "sales/deploy")]],
    [
      "the address grammar manifest.yml uses",
      "shop/sales/skill/deploy",
      [artifactKey("skill", "sales/deploy")],
    ],
    [
      "a whole namespace",
      "shop/sales",
      [artifactKey("skill", "sales/deploy"), artifactKey("skill", "sales/lint")],
    ],
    [
      "one of two kinds that share a name",
      "shop/engineering/agent/lint",
      [artifactKey("agent", "engineering/lint")],
    ],
    [
      "an address with no namespace, wherever it is",
      "shop/skill/lint",
      [artifactKey("skill", "engineering/lint"), artifactKey("skill", "sales/lint")],
    ],
    [
      "a local artifact the registry does not carry yet",
      "shop/skill/written-here",
      [artifactKey("skill", "written-here")],
    ],
  ])("resolves %s", (_, ref, expected) => {
    expect([...(scopedKeys([ref], catalog, REGISTRY) ?? [])].sort()).toEqual(expected);
  });

  test("reaches an installed artifact by the namespace its lock row records", () => {
    const installed = {
      items: [item("lint")],
      local: [],
      undeclared: [],
      pinned: { registries: {}, artifacts: { lint: { name: "lint", namespace: "engineering" } } },
    } as unknown as Scan;

    expect([...(scopedKeys(["shop/engineering/skill/lint"], installed, REGISTRY) ?? [])]).toEqual([
      artifactKey("skill", "lint"),
    ]);
  });

  test("reaches the whole registry, and only this job's", () => {
    const scoped = scopedKeys(["shop"], catalog, REGISTRY);
    expect([...(scoped ?? [])]).not.toContain(artifactKey("skill", "other/deploy"));
    expect([...(scoped ?? [])]).toContain(artifactKey("skill", "loose"));
  });

  test("refuses a ref that reaches nothing rather than running empty", () => {
    expect(() => scopedKeys(["shop/sales/skill/absent"], catalog, REGISTRY)).toThrow(RunScopeError);
  });

  test("refuses an address whose registry is not this job's", () => {
    expect(() => scopedKeys(["elsewhere/other/skill/deploy"], catalog, REGISTRY)).toThrow(
      RunScopeError,
    );
  });

  test("names every ref that missed, so one call fixes them all", () => {
    try {
      scopedKeys(["sales/deploy", "nope", "also/nope"], catalog, REGISTRY);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RunScopeError);
      expect((error as RunScopeError).refs).toEqual(["nope", "also/nope"]);
    }
  });
});
