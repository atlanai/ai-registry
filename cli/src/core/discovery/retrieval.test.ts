import { describe, expect, test } from "vitest";
import { fingerprint, retrieve, type Skill } from "./retrieval.ts";

const recap: Skill = {
  key: "example/recap",
  registry: "example",
  namespace: "",
  name: "recap",
  description: "Summarize notes",
  version: "1",
  digest: "one",
};
const drawing: Skill = {
  ...recap,
  key: "example/drawing",
  name: "drawing",
  description: "Draw a diagram",
};
describe("hybrid skill retrieval", () => {
  test("retrieves a semantic match without keyword overlap and excludes stale entries", () => {
    const index = new Map([
      [recap.key, { fingerprint: fingerprint(recap), vector: [1, 0] }],
      [drawing.key, { fingerprint: fingerprint(drawing), vector: [0, 1] }],
    ]);
    expect(retrieve("meeting synthesis", [1, 0], [recap, drawing], index)[0]).toEqual(recap);
    expect(
      retrieve("meeting synthesis", [1, 0], [{ ...recap, version: "2" }, drawing], index),
    ).toEqual([drawing]);
  });
  test("refuses mismatched dimensions instead of returning misleading rankings", () => {
    const index = new Map([[recap.key, { fingerprint: fingerprint(recap), vector: [1, 0] }]]);
    expect(() => retrieve("notes", [1], [recap], index)).toThrow("dimensions changed");
  });
});

test("duplicate catalog rows cannot multiply fusion scores or consume candidate slots", () => {
  const index = new Map([
    [recap.key, { fingerprint: fingerprint(recap), vector: [1, 0] }],
    [drawing.key, { fingerprint: fingerprint(drawing), vector: [0, 1] }],
  ]);
  expect(retrieve("diagram", [0, 1], [recap, recap, recap, drawing], index)).toEqual([
    drawing,
    recap,
  ]);
});
test("identical copies under different keys occupy one candidate slot", () => {
  const copy = { ...drawing, key: "example/copy" };
  const index = new Map(
    [drawing, copy].map((skill) => [
      skill.key,
      { fingerprint: fingerprint(skill), vector: [0, 1] },
    ]),
  );
  expect(retrieve("diagram", [0, 1], [drawing, copy], index)).toHaveLength(1);
});
