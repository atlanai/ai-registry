import { describe, expect, test } from "vitest";
import { type AdapterConfigSchema, assertAdapterConfig } from "./config.ts";

describe("assertAdapterConfig", () => {
  test("allows anything when the adapter names no schema", () => {
    expect(() => assertAdapterConfig("probe", undefined, { extra: "1" })).not.toThrow();
  });

  test("mints CONFIG_INVALID for missing required keys and unknown properties", () => {
    const schema = {
      required: ["endpoint"],
      properties: { endpoint: { type: "string" as const } },
    };
    expect(() => assertAdapterConfig("probe", schema, {})).toThrow(
      "The probe adapter needs `endpoint` in its config.",
    );
    expect(() =>
      assertAdapterConfig("probe", schema, { endpoint: "https://x", extra: "1" }),
    ).toThrow("The probe adapter does not take `extra` in its config.");
    expect(() => assertAdapterConfig("probe", schema, { endpoint: "https://x" })).not.toThrow();
  });

  test("names the keys an adapter does take, or that it takes none", () => {
    const refused = (schema: AdapterConfigSchema) => {
      try {
        assertAdapterConfig("probe", schema, { extra: "1" });
      } catch (error) {
        return (error as { hint?: string }).hint;
      }
      return undefined;
    };
    expect(refused({ properties: { ref: { type: "string" }, path: { type: "string" } } })).toBe(
      "Leave it out: the probe adapter takes `ref` and `path`.",
    );
    expect(refused({ properties: {} })).toBe(
      "Leave out --config: the probe adapter takes no settings.",
    );
  });
});
