import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SchemaObject } from "ajv/dist/2020.js";
import { describe, expect } from "vitest";
import skill from "#schema/kinds/skill.json" with { type: "json" };
import { test } from "#test/kit/fixtures.ts";
import { kindsOf, manifestProblems } from "./kinds.ts";
import { check, prepareManifest } from "./schema.ts";

const custom = () => ({
  ...skill,
  $id: "kinds/custom.json",
  title: "custom",
  required: ["mode", "values"],
  properties: {
    mode: { const: "safe" },
    values: { type: "array", minItems: 1, items: { $ref: "#/$defs/value" } },
  },
  $defs: { value: { type: "integer", minimum: 1 } },
  allOf: JSON.parse(`[
    {"if": {"properties": {"mode": {"const": "safe"}}},
     "then": {"properties": {"values": {"maxItems": 2}}}}
  ]`) as SchemaObject[],
});

describe("Draft 2020-12 kind validation", () => {
  test("enforces references, constants, composition, arrays and conditionals", async ({ tmp }) => {
    const schema = custom();
    await prepareManifest(tmp, schema);
    expect(check(schema, { mode: "safe", values: [1, 2] })).toEqual([]);
    for (const value of [
      { mode: "unsafe", values: [1] },
      { mode: "safe", values: [] },
      { mode: "safe", values: [0] },
      { mode: "safe", values: ["1"] },
      { mode: "safe", values: [1, 2, 3] },
    ])
      expect(check(schema, value)).not.toEqual([]);
    expect(check({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1)).not.toEqual([]);
    expect(check({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1.5)).toEqual([]);
    expect(
      check({ type: "array", prefixItems: [{ const: "first" }], items: false }, ["first", "extra"]),
    ).not.toEqual([]);
  });

  test("preserves values and treats format as an annotation", () => {
    const schema = {
      type: "object",
      additionalProperties: true,
      properties: {
        count: { type: "integer", default: 1 },
        uri: { type: "string", format: "uri" },
      },
    };
    const value = { uri: "not a uri", extra: { keep: true } };
    const original = structuredClone(value);
    expect(check(schema, value)).toEqual([]);
    expect(value).toEqual(original);
    const invalid = { ...value, count: "1" };
    expect(check(schema, invalid)).not.toEqual([]);
    expect(invalid.count).toBe("1");
  });

  test("loads nested local schemas through the registry reader and isolates registries", async ({
    tmp,
  }) => {
    for (const [name, required] of [
      ["one", "safe"],
      ["two", "other"],
    ]) {
      const root = join(tmp, name!);
      await mkdir(join(root, "kinds"), { recursive: true });
      await writeFile(
        join(root, "kinds", "mode.json"),
        JSON.stringify({ $defs: { mode: { const: required } } }),
      );
      const schema = {
        ...custom(),
        properties: { ...custom().properties, mode: { $ref: "mode.json#/$defs/mode" } },
      };
      await prepareManifest(root, schema);
      expect(check(schema, { mode: required, values: [1] })).toEqual([]);
      expect(check(schema, { mode: "wrong", values: [1] })).not.toEqual([]);
    }
  });

  test("reports invalid manifest shape, malformed schemas and unresolved refs", async ({ tmp }) => {
    await expect(prepareManifest(tmp, {})).rejects.toThrow("not a kind manifest");
    await expect(prepareManifest(tmp, { ...custom(), required: 1 })).rejects.toThrow();
    await expect(
      prepareManifest(tmp, { ...custom(), properties: { mode: { $ref: "missing.json" } } }),
    ).rejects.toThrow("missing");
    await expect(
      prepareManifest(tmp, {
        ...custom(),
        properties: { mode: { $ref: "https://example.invalid/schema.json" } },
      }),
    ).rejects.toThrow("external schema");
    await expect(
      prepareManifest(tmp, { ...custom(), properties: { mode: { $ref: "../../outside.json" } } }),
    ).rejects.toThrow();
    await expect(prepareManifest(tmp, { ...custom(), $async: true })).rejects.toThrow(
      "asynchronous",
    );
    await mkdir(join(tmp, "kinds"));
    await writeFile(join(tmp, "outside.json"), "true");
    await symlink(join(tmp, "outside.json"), join(tmp, "kinds", "linked.json"));
    await expect(
      prepareManifest(tmp, { ...custom(), properties: { mode: { $ref: "linked.json" } } }),
    ).rejects.toThrow();
  });

  test("reports served manifest errors instead of crashing or silently accepting them", async ({
    tmp,
  }) => {
    await mkdir(join(tmp, "kinds"));
    await writeFile(
      join(tmp, "registry.json"),
      JSON.stringify({ kinds: [{ name: "custom", manifest_url: "kinds/custom.json" }] }),
    );
    await writeFile(
      join(tmp, "kinds", "custom.json"),
      JSON.stringify({ ...custom(), properties: { mode: { $ref: "missing.json" } } }),
    );
    expect(await kindsOf(tmp)).toEqual({});
    expect(await manifestProblems(tmp)).toEqual([
      { path: "kinds/custom.json", message: expect.stringContaining("missing") },
    ]);
  });
});
