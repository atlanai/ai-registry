import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { RegistrySource } from "#core/manifest/model.ts";
import { test } from "#test/kit/fixtures.ts";
import { asAddress, sameLocation } from "./registries.ts";

describe("sameLocation", () => {
  test.for([
    ["its name with .git", "/regs/team", "/regs/team.git"],
    ["a URL", "/regs/kit", "file:///regs/kit"],
  ])("tells a folder apart from %s", ([, left, right]) => {
    expect(sameLocation(left as string, right as string)).toBe(false);
  });

  test("matches one folder however its path is spelled", async ({ tmp }) => {
    const team = join(tmp, "regs", "team");
    await mkdir(join(tmp, "regs", "other"), { recursive: true });
    await mkdir(team);
    expect(sameLocation(team, `${team}/`)).toBe(true);
    expect(sameLocation(team, `${tmp}/regs/other/../team`)).toBe(true);
  });
});

describe("asAddress", () => {
  test("reuses the name a repository is already declared under", () => {
    const known = {
      tools: { location: "https://github.com/acme/kit.git", adapter: undefined, config: {} },
    } satisfies Record<string, RegistrySource>;
    expect(asAddress("https://github.com/acme/kit/team/lint", known)).toEqual({
      address: "tools/team/lint",
      known,
    });
  });

  test("declares a new repository in what it returns, leaving the registries passed in", () => {
    const known: Record<string, RegistrySource> = {};
    const { address, known: reached } = asAddress("https://github.com/acme/kit/team/lint", known);
    expect(address).toBe("kit/team/lint");
    expect(reached).toEqual({
      kit: { location: "github.com/acme/kit", adapter: undefined, config: {} },
    });
    expect(known).toEqual({});
  });
});
