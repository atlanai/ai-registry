import { describe, expect, it } from "vitest";
import { formatAddress, formatRef, parseRef, RefParseError, withLocalName } from "./ref.ts";

describe("parseRef", () => {
  it.each([
    ["kit", { registry: "kit" }],
    ["kit/sales", { registry: "kit", namespace: "sales" }],
    ["kit/skill/lint", { registry: "kit", kind: "skill", name: "lint" }],
    [
      "kit/sales/skill/deploy",
      { registry: "kit", namespace: "sales", kind: "skill", name: "deploy" },
    ],
    ["kit/skill/lint@1.2.0", { registry: "kit", kind: "skill", name: "lint", version: "1.2.0" }],
    [
      "kit/sales/skill/deploy@2.0.0",
      { registry: "kit", namespace: "sales", kind: "skill", name: "deploy", version: "2.0.0" },
    ],
    // Three segments read as namespace and name when the middle is not a kind.
    ["kit/sales/deploy", { registry: "kit", namespace: "sales", name: "deploy" }],
    [
      "kit/sales/deploy@2.0.0",
      { registry: "kit", namespace: "sales", name: "deploy", version: "2.0.0" },
    ],
  ])("reads %s", (input, expected) => {
    expect(parseRef(input)).toEqual(expected);
  });

  it("treats `latest` as the absence of a pin, so it never becomes one", () => {
    const ref = parseRef("kit/skill/lint@latest");
    expect(ref.version).toBeUndefined();
    expect(formatRef(ref)).toBe("kit/skill/lint");
  });

  it.each([
    ["kit@1.0.0", /only one artifact can be pinned to a version/],
    ["kit/sales@1.0.0", /only one artifact can be pinned to a version/],
    ["kit/skill/lint@", /no version follows the @/],
    ["kit/skill/lint@1.0.0@2", /at most one @version/],
    ["kit/skill/lint@../etc", /is not a version/],
    ["", /it is empty/],
    ["kit/../lint", /is not valid/],
    ["kit/plugin/deploy", /addressed as its namespace/],
    ["kit/sales/plugin/deploy", /addressed as its namespace/],
    ["a/b/skill/c/d", /too many parts/],
  ])("refuses %j", (input, message) => {
    expect(() => parseRef(input)).toThrow(RefParseError);
    expect(() => parseRef(input)).toThrow(message);
  });

  it.each([
    ["kit/plugin/deploy", "kit/deploy"],
    ["kit/plugin/deploy@1.0.0", "kit/deploy"],
    ["kit/sales/plugin/deploy", "kit/deploy"],
  ])("suggests the plugin's own address for %j", (input, address) => {
    expect(() => parseRef(input)).toThrow(
      `a plugin is addressed as its namespace. Write ${address}.`,
    );
  });
});

describe("withLocalName", () => {
  it("takes a name in the spec's grammar", () => {
    expect(withLocalName(parseRef("kit/skill/lint"), "my-lint").localName).toBe("my-lint");
  });

  // On a case-insensitive disk `Foo` and `foo` are one folder.
  it.each(["Foo", "a:b", "-lint", "con", "..", "a/b", "a\\b", ""])("refuses %j", (name) => {
    expect(() => withLocalName(parseRef("kit/skill/lint"), name)).toThrow(
      `${JSON.stringify(name.trim())} cannot be a local name.`,
    );
  });
});

describe("formatting", () => {
  // formatRef is what the manifest stores, so the short form survives as written.
  it.each(["kit/sales/skill/deploy@2.0.0", "kit/sales/deploy@2.0.0", "kit/skill/lint"])(
    "round-trips %s through formatRef",
    (input) => {
      expect(formatRef(parseRef(input))).toBe(input);
      expect(formatRef(parseRef(formatRef(parseRef(input))))).toBe(input);
    },
  );

  it.each([
    ["kit/skill/lint@1.2.0", "kit/skill/lint"],
    ["kit/skill/lint", "kit/skill/lint"],
    ["kit/sales/deploy", "kit/sales/deploy"],
  ])("formats %s's address without the pin, which is its identity", (input, address) => {
    expect(formatAddress(parseRef(input))).toBe(address);
  });
});
