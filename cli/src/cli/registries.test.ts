import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Interaction } from "#cli/prompt/flow.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { Printer } from "#core/output.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import { test } from "#test/kit/fixtures.ts";
import { asAddress, chooseRegistry, sameLocation } from "./registries.ts";

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

test("asAddress reuses the name a repository is already declared under", () => {
  const known = {
    tools: { location: "https://github.com/acme/kit.git", adapter: undefined, config: {} },
  } satisfies Record<string, RegistrySource>;
  expect(asAddress("https://github.com/acme/kit/team/lint", known)).toBe("tools/team/lint");
});

describe("chooseRegistry", () => {
  test("shows each registry's address on one line of inert text", async () => {
    const known: Record<string, RegistrySource> = {
      kit: {
        location:
          "https://example.test/kit\u001B]8;;https://example.test/\u0007x\u001B]8;;\u0007\n│  ○ trusted  https://example.test/trusted",
        adapter: undefined,
        config: {},
      },
    };
    const term = terminal();
    // Built by hand: whatever runs the tests, a person is at this terminal.
    const step: Interaction = { io: term.io, printer: new Printer(), blocked: undefined };
    const run = chooseRegistry(step, known);
    await term.press();
    const frame = term.screen();
    await term.press(KEY.enter);
    expect(await run).toBe("kit");
    expect(frame.slice(0, 4)).toEqual([
      "◆  Install from which registry?",
      "│",
      "│  ● kit  https://example.test/kitx │ ○ trusted https://example.test/trusted",
      "│",
    ]);
    expect(term.written()).not.toContain("\u001B]8;");
  });
});
