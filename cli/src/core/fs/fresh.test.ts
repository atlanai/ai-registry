import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { test } from "#test/kit/fixtures.ts";
import { refuseRedirect, writeFresh } from "./fresh.ts";

describe.skipIf(process.platform === "win32")("refuseRedirect", () => {
  test("refuses a link between the root and the path, with the caller's hint", async ({ tmp }) => {
    await mkdir(join(tmp, "elsewhere"));
    await symlink(join(tmp, "elsewhere"), join(tmp, "artifacts"));
    expect(() => refuseRedirect(tmp, join(tmp, "artifacts", "team"), "Use --dir.")).toThrow(
      expect.objectContaining({ code: ErrorCode.Invalid, hint: "Use --dir." }),
    );
  });

  test("lets a path of real folders, or none yet, through", async ({ tmp }) => {
    await mkdir(join(tmp, "artifacts"));
    expect(() => refuseRedirect(tmp, join(tmp, "artifacts", "team"))).not.toThrow();
  });
});

describe("writeFresh", () => {
  test("reports a file already there as a conflict and leaves it as it was", async ({ tmp }) => {
    const path = join(tmp, "SKILL.md");
    await writeFile(path, "theirs");
    await expect(writeFresh(path, "ours", { shown: "SKILL.md", hint: "Move it." })).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.Conflict, message: "SKILL.md already exists." }),
    );
    expect(await readFile(path, "utf8")).toBe("theirs");
  });
});
