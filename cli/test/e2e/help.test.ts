import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";

// Each command's own page is snapshotted in process by src/cli/help/print.test.ts.
// Regenerate with `vitest run --project e2e -u` after a deliberate change to help text.
describe("aireg --help", () => {
  test("lists the commands and examples, on stdout", async ({ aireg, redact }) => {
    const ran = await aireg(["--help"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toBe("");
    await expect(redact(ran.stdout)).toMatchFileSnapshot("__snapshots__/help/aireg.txt");
  });
});
