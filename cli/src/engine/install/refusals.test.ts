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
    expect(trustHint([hooked], { scope: "project", address: ["../my kits"] })).toBe(
      "Read what it runs, then run `aireg add '../my kits' -s kit --trust kit`.",
    );
  });

  test("carries the source flags typed, so it reads what was reviewed", () => {
    expect(
      trustHint([hooked], {
        scope: "user",
        address: ["../kits", "--ref", "v1 beta", "--as", "mine"],
      }),
    ).toBe(
      "Read what it runs, then run `aireg add ../kits --ref 'v1 beta' --as mine -s kit --trust kit -g`.",
    );
  });
});
