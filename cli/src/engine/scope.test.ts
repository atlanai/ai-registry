import { describe, expect, it } from "vitest";
import type { Candidate } from "#core/sync/adopt.ts";
import type { SyncItem } from "#core/sync/model.ts";
import type { Scan } from "./scan.ts";
import { RunScopeError, scopedKeys } from "./scope.ts";

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
  [candidate("written-here"), candidate("helper"), candidate("helper", "agent")],
);

describe("scopedKeys", () => {
  it("covers everything the job does when no refs were asked for", () => {
    expect(scopedKeys(undefined, catalog, REGISTRY)).toBeUndefined();
  });

  it.each([
    ["the catalog name", "sales/deploy", ["skill:sales/deploy"]],
    ["the address grammar manifest.yml uses", "shop/sales/skill/deploy", ["skill:sales/deploy"]],
    ["a whole namespace", "shop/sales", ["skill:sales/deploy", "skill:sales/lint"]],
    [
      "one of two kinds that share a name",
      "shop/engineering/agent/lint",
      ["agent:engineering/lint"],
    ],
    [
      "an address with no namespace, wherever it is",
      "shop/skill/lint",
      ["skill:engineering/lint", "skill:sales/lint"],
    ],
    [
      "a local artifact the registry does not carry yet",
      "shop/skill/written-here",
      ["skill:written-here"],
    ],
    ["one kind of two local artifacts that share a name", "shop/skill/helper", ["skill:helper"]],
    [
      "every kind of a local name, when no kind is named",
      "helper",
      ["agent:helper", "skill:helper"],
    ],
  ])("resolves %s", (_, ref, expected) => {
    expect([...(scopedKeys([ref], catalog, REGISTRY) ?? [])].sort()).toEqual(expected);
  });

  it("reaches the whole registry, and only this job's", () => {
    const scoped = scopedKeys(["shop"], catalog, REGISTRY);
    expect([...(scoped ?? [])]).not.toContain("skill:other/deploy");
    expect([...(scoped ?? [])]).toContain("skill:loose");
  });

  it("refuses a ref that reaches nothing rather than running empty", () => {
    expect(() => scopedKeys(["shop/sales/skill/absent"], catalog, REGISTRY)).toThrow(RunScopeError);
  });

  it("refuses an address whose registry is not this job's", () => {
    expect(() => scopedKeys(["elsewhere/other/skill/deploy"], catalog, REGISTRY)).toThrow(
      RunScopeError,
    );
  });

  it("names every ref that missed, so one call fixes them all", () => {
    try {
      scopedKeys(["sales/deploy", "nope", "also/nope"], catalog, REGISTRY);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RunScopeError);
      expect((error as RunScopeError).refs).toEqual(["nope", "also/nope"]);
    }
  });
});
