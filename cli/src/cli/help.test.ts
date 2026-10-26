import { describe, expect, vi } from "vitest";
import { COMMANDS } from "#cli/commands/table.ts";
import { ExitCode } from "#core/errors.ts";
import { Printer } from "#core/output.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { printHelp } from "./help.ts";

// The e2e suite checks the root page against the built CLI from the same folder.
const SNAPSHOTS = "../../test/e2e/__snapshots__/help";

/** The built-in commands, and the skill and agent commands every scope has outside a registry. */
const PAGES: string[] = [
  ...COMMANDS.flatMap((command) => [
    command.name,
    ...(command.actions ?? []).map((action) => `${command.name} ${action.name}`),
  ]),
  ...["skill", "agent"].flatMap((kind) => [kind, `${kind} new`, `${kind} bump`]),
];

// Regenerate with `vitest run src/cli/help.test.ts -u` after a deliberate change to help text.
describe("aireg <command> [<action>] --help", () => {
  test.for(PAGES)("%s", async (page, { tmp }) => {
    const out: string[] = [];
    const err: string[] = [];
    const printer = new Printer({
      out: { write: (chunk: string) => out.push(chunk), isTTY: false },
      err: { write: (chunk: string) => err.push(chunk), isTTY: false },
    });
    // From an empty folder, so no registry around this checkout adds kinds to the table.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      expect(await printHelp(printer, page.split(" "), false)).toBe(ExitCode.Ok);
    } finally {
      cwd.mockRestore();
    }
    expect(err).toEqual([]);
    await expect(out.join("")).toMatchFileSnapshot(`${SNAPSHOTS}/${page.replace(" ", "/")}.txt`);
  });
});
