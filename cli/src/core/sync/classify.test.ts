import { describe, expect, test } from "vitest";
import { classify } from "./classify.ts";

const D = (base?: string, local?: string, upstream?: string) => ({ base, local, upstream });

type Row = [string | undefined, string | undefined, string | undefined, string, string];

describe("classify", () => {
  test.each<Row>([
    ["a", "b", "b", "synced", "the two sides hold the same bytes"],
    ["a", "a", "a", "synced", "nothing moved"],
    ["a", "a", "b", "pull", "only the registry moved"],
    [undefined, undefined, "b", "pull", "only the registry holds it"],
    ["a", "b", "a", "publish", "only the project moved"],
    ["a", "b", "c", "conflict", "both moved differently"],
    [undefined, "b", undefined, "adopt", "it is here and published nowhere"],
    ["a", undefined, "a", "archive", "the project deleted the base"],
    ["a", "a", undefined, "pull-delete", "the registry deleted the base"],
    ["a", undefined, undefined, "removed", "both deleted the base"],
    ["a", undefined, "b", "conflict", "a local deletion races an upstream edit"],
    ["a", "b", undefined, "conflict", "an upstream deletion races a local edit"],
  ])("classifies %s/%s/%s as %s when %s", (base, local, upstream, disposition) => {
    expect(classify(D(base, local, upstream)).disposition).toBe(disposition);
  });

  test("explains a conflict", () => {
    expect(classify(D("a", "b", "c")).detail).toMatch(/edited here and changed in the registry/);
  });

  // Guessing a direction with no base silently discards work.
  test("refuses a direction with no base", () => {
    expect(classify(D(undefined, "b", "c")).detail).toMatch(/no digest/);
    expect(classify(D("", "b", "c")).disposition).toBe("unknown");
  });
});
