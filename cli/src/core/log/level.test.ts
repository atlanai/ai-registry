import { describe, expect, test } from "vitest";
import { LogLevelError, resolveLevel } from "./level.ts";

describe("resolveLevel", () => {
  test.each([
    ["falls back when nothing asks for a level", {}, undefined, "info"],
    ["reads the environment", { AIREG_LOG_LEVEL: "debug" }, undefined, "debug"],
    ["lets the flag beat the environment", { AIREG_LOG_LEVEL: "warn" }, "trace", "trace"],
    ["accepts off", { AIREG_LOG_LEVEL: "off" }, undefined, "off"],
    ["ignores case and whitespace", { AIREG_LOG_LEVEL: "  WARN " }, undefined, "warn"],
  ])("%s", (_, env, flag, level) => {
    expect(resolveLevel("info", flag === undefined ? { env } : { flag, env })).toBe(level);
  });

  test("names the accepted levels, and where a bad level came from", () => {
    expect(() => resolveLevel("info", { flag: "loud" })).toThrow(LogLevelError);
    expect(() => resolveLevel("info", { flag: "loud" })).toThrow(
      '--log-level takes trace, debug, info, warn, error, fatal or off, not "loud".',
    );
    expect(() => resolveLevel("info", { env: { AIREG_LOG_LEVEL: "bogus" } })).toThrow(
      'AIREG_LOG_LEVEL takes trace, debug, info, warn, error, fatal or off, not "bogus".',
    );
  });
});
