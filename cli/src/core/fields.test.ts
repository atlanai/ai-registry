import { describe, expect, test } from "vitest";
import {
  hasOnly,
  isRecord,
  namesOf,
  parseDuration,
  readers,
  textMapOf,
  textOf,
  unknownKeys,
} from "./fields.ts";

describe("the plain readers", () => {
  test("take a mapping, and not null or a list", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
  });

  test("read text only when it holds more than whitespace", () => {
    expect(textOf("lint")).toBe("lint");
    expect(textOf("  ")).toBeUndefined();
    expect(textOf(3)).toBeUndefined();
  });

  test("read a list of names only when every item is one", () => {
    expect(namesOf(["a", "b"])).toEqual(["a", "b"]);
    expect(namesOf([])).toBeUndefined();
    expect(namesOf(["a", ""])).toBeUndefined();
    expect(namesOf("a")).toBeUndefined();
  });

  test("read a map of text only when every key and value is text", () => {
    expect(textMapOf({ host: "example.com" })).toEqual({ host: "example.com" });
    expect(textMapOf({ host: 1 })).toBeUndefined();
    expect(textMapOf({ " ": "x" })).toBeUndefined();
    expect(textMapOf(["x"])).toBeUndefined();
  });

  test("name the keys an entry has beyond those known, sorted", () => {
    expect(unknownKeys({ b: 1, a: 1, name: 1 }, ["name"])).toEqual(["a", "b"]);
    expect(hasOnly({ name: "x" }, ["name", "version"])).toBe(true);
    expect(hasOnly({ name: "x", extra: 1 }, ["name"])).toBe(false);
    expect(hasOnly(null, ["name"])).toBe(false);
  });
});

describe("readers", () => {
  class Refused extends Error {}
  const read = readers((message) => new Refused(message), "a mapping");

  test("refuse a bad field with the caller's error, naming where it is", () => {
    expect(() => read.text({ name: "" }, "name", "artifacts.0")).toThrow(Refused);
    expect(() => read.text({}, "name", "artifacts.0")).toThrow(
      "`artifacts.0.name` must be a non-empty string.",
    );
    expect(() => read.record([], "registries")).toThrow("`registries` must be a mapping.");
    expect(() => read.flag({ on: "yes" }, "on")).toThrow("`on` must be true or false.");
    expect(() => read.integer({ every: 1.5 }, "every")).toThrow("`every` must be a whole number.");
    expect(() => read.oneOf({ kind: "tool" }, "kind", ["skill", "agent"])).toThrow(
      "`kind` must be skill or agent.",
    );
    expect(() => read.textList(["a", 2], "tags")).toThrow(
      "`tags` must list only non-empty strings.",
    );
  });

  test("fall back only when a field is absent, never when it is wrong", () => {
    expect(read.optionalText({}, "note")).toBeUndefined();
    expect(read.optionalFlag({}, "on", true)).toBe(true);
    expect(read.choice({}, "kind", ["skill", "agent"], "skill")).toBe("skill");
    expect(() => read.optionalFlag({ on: 1 }, "on", true)).toThrow(Refused);
    expect(() => read.choice({ kind: "x" }, "kind", ["skill"], "skill")).toThrow(Refused);
  });

  test("name every key it does not take, and the ones it does", () => {
    expect(() => read.onlyKnown({ name: "x", colour: 1, size: 2 }, ["name"], "")).toThrow(
      'The file does not take "colour" and "size"; it takes name.',
    );
    expect(() => read.onlyKnown({ extra: 1 }, ["b", "a"], "jobs.0")).toThrow(
      '`jobs.0` does not take "extra"; it takes a and b.',
    );
    expect(() => read.onlyKnown({ name: "x" }, ["name"], "")).not.toThrow();
  });
});

describe("parseDuration", () => {
  test("reads seconds, minutes, hours and days, and a bare number as seconds", () => {
    expect(parseDuration("900")).toBe(900_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("soon")).toBeUndefined();
  });
});
