import { describe, expect, test } from "vitest";
import type { LogRecord } from "./model.ts";
import { isRaw, matches, parseLine, parseSince } from "./read.ts";

const record: LogRecord = {
  timestamp: "2026-09-15T12:00:00.000Z",
  severity_text: "warn",
  severity_number: 13,
  body: "job could not be started",
  attributes: { jobId: "w1" },
};

describe("parseLine", () => {
  test("reads a record the logger wrote", () => {
    const entry = parseLine(JSON.stringify(record));
    expect(entry).toMatchObject({ body: "job could not be started" });
  });

  test("keeps a non-JSON line as raw, for captured stderr", () => {
    const entry = parseLine("(node:1) ExperimentalWarning: something");
    expect(entry !== undefined && isRaw(entry)).toBe(true);
  });

  test("treats JSON that is not a log record as raw", () => {
    const entry = parseLine(JSON.stringify({ hello: "world" }));
    expect(entry !== undefined && isRaw(entry)).toBe(true);
  });

  test("skips a blank line", () => {
    expect(parseLine("   ")).toBeUndefined();
  });
});

describe("matches", () => {
  test("drops anything below the asked-for level", () => {
    expect(matches(record, { minLevel: "error" })).toBe(false);
    expect(matches(record, { minLevel: "debug" })).toBe(true);
  });

  test("filters on a time window", () => {
    expect(matches(record, { sinceMs: Date.parse("2026-09-15T13:00:00Z") })).toBe(false);
    expect(matches(record, { sinceMs: Date.parse("2026-09-15T11:00:00Z") })).toBe(true);
  });

  test("searches attributes as well as the message", () => {
    expect(matches(record, { contains: "w1" })).toBe(true);
    expect(matches(record, { contains: "absent" })).toBe(false);
  });

  test("applies only text filters to a raw line", () => {
    expect(matches({ raw: "boom" }, { minLevel: "fatal" })).toBe(true);
    expect(matches({ raw: "boom" }, { contains: "nope" })).toBe(false);
  });
});

describe("parseSince", () => {
  test("reads a duration as that long before now", () => {
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    expect(parseSince("15m", now)).toBe(now - 15 * 60_000);
    expect(parseSince("2h", now)).toBe(now - 2 * 3_600_000);
  });

  test("reads an absolute date", () => {
    expect(parseSince("2026-09-15T00:00:00Z")).toBe(Date.parse("2026-09-15T00:00:00Z"));
  });

  test("rejects something that is neither", () => {
    expect(() => parseSince("whenever")).toThrow(expect.objectContaining({ code: "usage" }));
  });
});
