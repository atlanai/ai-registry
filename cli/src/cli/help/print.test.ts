import { describe, expect, vi } from "vitest";
import { COMMANDS } from "#cli/commands/index.ts";
import { ExitCode } from "#core/errors.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { capturedPrinter } from "#test/kit/printer.ts";
import { printHelp } from "./print.ts";

const SNAPSHOTS = "__snapshots__";

/** The root page is snapshotted by the e2e suite, against the built CLI. */
const PAGES: string[] = [
  ...COMMANDS.flatMap((command) => [
    command.name,
    ...(command.actions ?? []).map((action) => `${command.name} ${action.name}`),
  ]),
  ...["skill", "agent"].flatMap((kind) => [kind, `${kind} new`, `${kind} bump`]),
];

describe("aireg <command> [<action>] --help", () => {
  test.for(PAGES)("%s", async (page, { tmp }) => {
    const { printer, printed: out, errors: err } = capturedPrinter();
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
