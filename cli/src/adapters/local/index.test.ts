import { expect, test } from "vitest";
import { assertAdapterConfig } from "#adapter/config.ts";
import local from "./index.ts";

test("takes no config, so a stray --config is refused rather than ignored", () => {
  expect(() => assertAdapterConfig(local.id, local.configSchema, {})).not.toThrow();
  expect(() => assertAdapterConfig(local.id, local.configSchema, { x: "1" })).toThrow(
    /does not take `x`/,
  );
});
