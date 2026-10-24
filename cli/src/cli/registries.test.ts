import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { test } from "#test/kit/fixtures.ts";
import { asAddress, sameLocation } from "./registries.ts";

const at = (location: string): RegistrySource => ({ location, adapter: undefined, config: {} });

describe("sameLocation", () => {
  test("matches a repository however its URL is spelled", () => {
    expect(sameLocation("github.com/acme/kit", "https://github.com/Acme/kit.git")).toBe(true);
    expect(sameLocation("git@github.com:acme/kit.git", "github.com/acme/kit")).toBe(true);
  });

  test.for([
    ["a .git suffix", "/regs/team", "/regs/team.git"],
    ["a trailing space", "/regs/sp", "/regs/sp "],
    ["the scheme of a URL", "/regs/kit", "file:///regs/kit"],
  ])("tells two folders apart by %s", ([, left, right]) => {
    expect(sameLocation(left as string, right as string)).toBe(false);
  });

  test("compares folders that do not exist by their spelling, case included", () => {
    expect(sameLocation("/regs/acme", "/regs/ACME")).toBe(false);
  });

  test("matches one folder however its path is spelled", async ({ tmp }) => {
    const team = join(tmp, "regs", "team");
    await mkdir(join(tmp, "regs", "other"), { recursive: true });
    await mkdir(team);
    expect(sameLocation(team, `${team}/`)).toBe(true);
    expect(sameLocation(team, `${tmp}/regs/other/../team`)).toBe(true);
  });
});

// `github.com/<owner>/<repo>/<address>` names the repository typed, whatever this scope declares.
describe("asAddress", () => {
  test("declares a repository under its own name when the name is free", () => {
    const known: Record<string, RegistrySource> = {};
    expect(asAddress("github.com/acme/kit/team/lint", known)).toBe("kit/team/lint");
    expect(known.kit?.location).toBe("github.com/acme/kit");
  });

  test("reuses the name a repository is already declared under", () => {
    const known = { tools: at("https://github.com/acme/kit.git") };
    expect(asAddress("https://github.com/acme/kit/team/lint", known)).toBe("tools/team/lint");
  });

  test.for([
    ["a folder", "/work/project/evil"],
    ["another repository", "https://github.com/someone/kit"],
  ])("refuses the name when %s holds it", ([, holder]) => {
    const known = { kit: at(holder as string) };
    expect(() => asAddress("github.com/acme/kit/team/lint", known)).toThrow(
      expect.objectContaining({
        code: ErrorCode.Usage,
        message: `The name "kit" is already taken by ${holder}.`,
      }),
    );
    expect(known.kit?.location).toBe(holder);
  });
});
