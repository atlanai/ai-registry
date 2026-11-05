import { describe, expect } from "vitest";
import type { RegistrySource } from "#core/manifest/model.ts";
import { Printer } from "#core/term/printer.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import { test } from "#test/kit/fixtures.ts";
import { chooseRegistry } from "./choose-registry.ts";
import type { Interaction } from "./interaction.ts";

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
