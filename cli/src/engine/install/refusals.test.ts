import { describe, expect, test } from "vitest";
import type { Untrusted } from "#core/plan/select.ts";
import { trustHint } from "./refusals.ts";

const hooked: Untrusted = { name: "kit", registry: "acme", carries: ["hooks"] };

describe("trustHint", () => {
  test("names the declared registry, with -g in your user scope", () => {
    expect(trustHint([hooked], { scope: "project" })).toBe(
      "Read what it runs, then run `aireg add acme/kit --trust kit`.",
    );
    expect(trustHint([hooked], { scope: "user" })).toBe(
      "Read what it runs, then run `aireg add acme/kit --trust kit -g`.",
    );
  });

  test("repeats the address typed when no registry stayed declared, quoted for the shell", () => {
    expect(trustHint([hooked], { scope: "project", address: "../my kits" })).toBe(
      "Read what it runs, then run `aireg add '../my kits' -s kit --trust kit`.",
    );
  });
});
