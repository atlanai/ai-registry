import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  envName,
  gitTimeoutMs,
  isCI,
  isSet,
  registryToken,
  SETTINGS,
  type Setting,
  setting,
  tokenVariable,
  withRegistryTokens,
} from "./env.ts";

const DOCS = readFileSync(
  new URL("../../../docs/reference/environment.md", import.meta.url),
  "utf8",
);

describe("settings", () => {
  it.each(Object.keys(SETTINGS).filter((name) => SETTINGS[name as Setting].public))(
    "documents %s",
    (name) => {
      expect(DOCS).toContain(`\`${envName(name as Setting)}\``);
    },
  );

  it("reads AIREG_<name> and treats empty as unset", () => {
    expect(setting("LOG_LEVEL", { AIREG_LOG_LEVEL: "debug" })).toBe("debug");
    expect(setting("LOG_LEVEL", { AIREG_LOG_LEVEL: " " })).toBeUndefined();
  });

  it("turns every switch on with any value, 0 included", () => {
    expect(isSet("DISABLE_UPDATE_CHECK", { AIREG_DISABLE_UPDATE_CHECK: "0" })).toBe(true);
    expect(isSet("DISABLE_UPDATE_CHECK", { AIREG_DISABLE_UPDATE_CHECK: " " })).toBe(false);
    expect(isCI({ CI: "true" })).toBe(true);
    expect(isCI({ CI: "" })).toBe(false);
  });

  it("names one token variable per registry alias", () => {
    expect(tokenVariable("acme-prod")).toBe("AIREG_TOKEN_ACME_PROD");
    expect(DOCS).toContain("`AIREG_TOKEN_<NAME>`");
  });
});

describe("gitTimeoutMs", () => {
  it("takes whole milliseconds, and five minutes when unset", () => {
    expect(gitTimeoutMs({ AIREG_GIT_TIMEOUT_MS: "45000" })).toBe(45_000);
    expect(gitTimeoutMs({})).toBe(300_000);
  });

  it("refuses anything else rather than reading a prefix of it", () => {
    for (const value of ["30s", "1e6", "1.5", "-1", "0"]) {
      expect(() => gitTimeoutMs({ AIREG_GIT_TIMEOUT_MS: value }), value).toThrow(
        `AIREG_GIT_TIMEOUT_MS is ${JSON.stringify(value)}, not a whole number of milliseconds.`,
      );
    }
  });
});

describe("withRegistryTokens", () => {
  const env = { AIREG_TOKEN_ACME: "from-env" };

  it("puts a run's own tokens in place of the environment's, for that run alone", async () => {
    const supplied = { AIREG_TOKEN_KIT: "supplied" };
    const inside = await withRegistryTokens(supplied, async () => {
      await Promise.resolve();
      return [registryToken("kit", env), registryToken("acme", env)];
    });
    expect(inside).toEqual(["supplied", undefined]);
    expect([registryToken("kit", env), registryToken("acme", env)]).toEqual([
      undefined,
      "from-env",
    ]);
  });
});
