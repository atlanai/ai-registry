import { expect, test } from "vitest";
import { setRecent } from "./lru.ts";

test("keeps the newest entries and drops the oldest past the limit", () => {
  const map = new Map<string, number>();
  setRecent(map, "a", 1, 2);
  setRecent(map, "b", 2, 2);
  setRecent(map, "a", 3, 2);
  setRecent(map, "c", 4, 2);
  expect([...map]).toEqual([
    ["a", 3],
    ["c", 4],
  ]);
});
