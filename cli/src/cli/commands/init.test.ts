import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { commandContext } from "#test/kit/command.ts";
import { test } from "#test/kit/fixtures.ts";
import { run } from "./init.ts";

function context(
  cwd: string,
  argv: string[],
  printed: string[] = [],
  format: "json" | "text" = "json",
) {
  return commandContext(argv, { cwd, format, printed });
}

describe("init", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  test("takes * for every target aireg knows", async ({ tmp: cwd }) => {
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    const writes: string[] = [];
    await run(context(cwd, ["--for", "*"], writes));
    const payload = JSON.parse(writes.join("")) as { data: { targets: string[] } };
    expect(payload.data.targets).toEqual(BUILTIN_TARGETS.map((target) => target.id).sort());
  });

  test("names the folders it installs into, as list and status name them", async ({ tmp: cwd }) => {
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    const writes: string[] = [];
    await run(context(cwd, ["--for", "claude-code,codex"], writes, "text"));
    expect(writes.join("")).toContain(
      "Installs for claude-code and codex, into .claude, .codex and .agents.",
    );
  });

  test("writes the manifest with the targets it chose, as aireg 0.1 names them", async ({
    tmp: cwd,
  }) => {
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    await run(context(cwd, ["--for", "claude-code,codex"]));
    expect(await readFile(join(cwd, ".registry", "manifest.yml"), "utf8")).toBe(
      "harnesses:\n  - claude\n  - codex\nregistries: {}\nartifacts: []\n",
    );
  });

  test("refuses a --publish-to that names no namespace before it writes anything", async ({
    tmp: cwd,
  }) => {
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    const argv = ["--registry", "../acme-registry", "--publish-to", "nonsense"];
    await expect(run(context(cwd, argv))).rejects.toMatchObject({
      code: ErrorCode.Usage,
      message: '--publish-to takes <registry>/<namespace>, not "nonsense".',
    });
    expect(existsSync(join(cwd, ".registry"))).toBe(false);
  });

  test.for(["-g", "--user"])("explains that %s needs no setup", async (flag, { tmp }) => {
    const error = await run(context(tmp, [flag])).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: "Your user scope needs no setup.",
      code: ErrorCode.Usage,
      hint: "Install into it with `aireg add -g`.",
    });
  });
});
