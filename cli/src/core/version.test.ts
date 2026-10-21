import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_REQUIREMENT, nodeTooOld } from "./version.ts";

const requirement = "^22.23.4 || ^24.22.1 || >=26.12.1";

describe("nodeTooOld", () => {
  it.each([
    "22.23.4",
    "22.23.5",
    "22.24.0",
    "24.22.1",
    "24.22.2",
    "24.23.0",
    "26.12.1",
    "26.12.2",
    "27.0.0",
  ])("accepts patched Node.js %s", (version) => {
    expect(nodeTooOld(version)).toBeUndefined();
  });

  it.each([
    "22.23.3",
    "24.22.0",
    "26.12.0",
    "22.23.4-rc.1",
    "24.22.1-rc.1",
    "26.12.1-rc.1",
    "22.24.0-rc.1",
    "24.23.0-rc.1",
    "27.0.0-rc.1",
    "20.99.0",
    "21.0.0",
    "23.99.0",
    "25.99.0",
  ])("refuses unpatched or unsupported Node.js %s", (version) => {
    expect(nodeTooOld(version)).toBe(`aireg requires Node.js ${requirement}; this is ${version}.`);
  });

  it.each(["", "not-a-version", "22.23"])(
    "preserves handling of malformed versions: %s",
    (version) => {
      expect(nodeTooOld(version)).toBeUndefined();
    },
  );

  it("does not treat Bun's emulated Node version as its certificate store", () => {
    expect(nodeTooOld("24.3.0", "1.3.12")).toBeUndefined();
  });

  it("holds the same requirement as the package's engines field", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } };
    expect(manifest.engines.node).toBe(NODE_REQUIREMENT);
    expect(NODE_REQUIREMENT).toBe(requirement);
  });
});
