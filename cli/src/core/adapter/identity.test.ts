import { describe, expect, test } from "vitest";
import { comparableLocation, sourceKey } from "./identity.ts";

describe("a registry's identity", () => {
  test("is the same with or without a trailing slash", () => {
    expect(sourceKey("https://example.com/acme/", {})).toBe(
      sourceKey("https://example.com/acme", {}),
    );
    expect(comparableLocation("./acme///")).toBe("./acme");
  });

  test("takes linear time on an address a hostile manifest padded with slashes", () => {
    const started = Date.now();
    sourceKey(`https://127.0.0.1:9/x${"/".repeat(80_000)}a`, {});
    comparableLocation(`x${"/".repeat(80_000)}a`);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("keeps the user of an ssh address, which names an account rather than a secret", () => {
    expect(sourceKey("ssh://git@example.com/acme/kit/", {})).toBe(
      sourceKey("ssh://git@example.com/acme/kit", {}),
    );
    expect(() => sourceKey("ssh://git:secret@example.com/acme/kit.git", {})).toThrow(
      /must not contain credentials/,
    );
    expect(() => sourceKey("https://token@example.com/acme/kit.git", {})).toThrow(
      /must not contain credentials/,
    );
  });
});

describe("a registry's config", () => {
  test("takes a key an object inherits, and refuses one that would reach its prototype", () => {
    expect(() => sourceKey("./acme", { toString: "a", hasOwnProperty: "b" })).not.toThrow();
    for (const key of ["__proto__", "constructor"]) {
      expect(() => sourceKey("./acme", JSON.parse(`{"${key}": "x"}`)), key).toThrow(
        /cannot name a registry config key/,
      );
    }
  });
});
