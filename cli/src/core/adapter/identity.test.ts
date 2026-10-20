import { describe, expect, it } from "vitest";
import {
  canonicalRegistryUrl,
  comparableLocation,
  declaredRegistryUrl,
  reportedRegistryUrl,
  sourceKey,
} from "./identity.ts";

describe("a registry's identity", () => {
  it("is the same with or without a trailing slash", () => {
    expect(sourceKey("https://example.com/acme/", {})).toBe(
      sourceKey("https://example.com/acme", {}),
    );
    expect(comparableLocation("./acme///")).toBe("./acme");
  });

  it("takes linear time on an address a hostile manifest padded with slashes", () => {
    const started = Date.now();
    sourceKey(`https://127.0.0.1:9/x${"/".repeat(80_000)}a`, {});
    comparableLocation(`x${"/".repeat(80_000)}a`);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("keeps the user of an ssh address, which names an account rather than a secret", () => {
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

describe("a registry's canonical URL", () => {
  it("is one https address however the registry was declared", () => {
    for (const location of [
      "github.com/acme/agent-registry",
      "https://github.com/acme/agent-registry.git",
      "https://GitHub.com/acme/agent-registry/",
      "http://github.com/acme/agent-registry",
      "git@github.com:acme/agent-registry.git",
      "ssh://git@github.com:22/acme/agent-registry.git",
      "github.com/acme/agent-registry@v2",
    ]) {
      expect(canonicalRegistryUrl(location), location).toBe(
        "https://github.com/acme/agent-registry",
      );
    }
    expect(canonicalRegistryUrl("https://example.com:8443/registry/")).toBe(
      "https://example.com:8443/registry",
    );
  });

  it("drops credentials, which never identify a registry", () => {
    expect(canonicalRegistryUrl("https://token@example.com/acme/kit.git")).toBe(
      "https://example.com/acme/kit",
    );
  });

  it("is undefined for a folder, a bare name or an address with no host an https root has", () => {
    for (const location of [
      "./registry",
      "/srv/registry",
      "~/registry",
      "acme",
      "file:///srv/r",
      "https://example.com/r?ref=x",
      "",
    ]) {
      expect(canonicalRegistryUrl(location), location).toBeUndefined();
    }
  });
});

describe("a registry's config", () => {
  it("takes a key an object inherits, and refuses one that would reach its prototype", () => {
    expect(() => sourceKey("./acme", { toString: "a", hasOwnProperty: "b" })).not.toThrow();
    for (const key of ["__proto__", "constructor"]) {
      expect(() => sourceKey("./acme", JSON.parse(`{"${key}": "x"}`)), key).toThrow(
        /cannot name a registry config key/,
      );
    }
  });
});

describe("the URL a declared registry is matched by", () => {
  it("is its declared address's, whatever the registry reports", () => {
    expect(
      declaredRegistryUrl("https://github.com/evil/registry", "https://github.com/acme/shared"),
    ).toBe("https://github.com/evil/registry");
  });

  it("is the https URL a folder reports, and nothing it reports otherwise", () => {
    expect(declaredRegistryUrl("./disk", "https://GitHub.com/acme/disk.git/")).toBe(
      "https://github.com/acme/disk",
    );
    expect(declaredRegistryUrl("./disk", "http://github.com/acme/disk")).toBeUndefined();
    expect(declaredRegistryUrl("./disk", "github.com/acme/disk")).toBeUndefined();
    expect(declaredRegistryUrl("./disk", undefined)).toBeUndefined();
    expect(reportedRegistryUrl(" https://example.com/x/ ")).toBe("https://example.com/x");
  });
});
