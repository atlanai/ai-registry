import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { Printer } from "#core/output.ts";
import { test } from "#test/kit/fixtures.ts";
import type { CommandContext } from "./index.ts";
import { run } from "./init.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

function context(cwd: string, argv: string[], writes: string[]): CommandContext {
  return {
    argv,
    cwd,
    printer: new Printer({
      format: "json",
      out: { write: (chunk: string) => writes.push(chunk), isTTY: false },
    }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}

describe("init", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  test("takes * for every harness aireg knows", async () => {
    const cwd = await mkdtemp(join(scratch, "aireg-init-"));
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    const writes: string[] = [];
    await run(context(cwd, ["--for", "*"], writes));
    const payload = JSON.parse(writes.join("")) as { data: { targets: string[] } };
    expect(payload.data.targets).toEqual(["agents", "claude", "codex", "copilot", "cursor"]);
  });

  test("names the folders it installs into, as list and status name them", async () => {
    const cwd = await mkdtemp(join(scratch, "aireg-init-"));
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    const writes: string[] = [];
    const printer = new Printer({
      color: "never",
      out: { write: (chunk: string) => writes.push(chunk), isTTY: false },
      err: { write: () => true, isTTY: false },
    });
    await run({ ...context(cwd, ["--for", "claude,codex"], writes), printer });
    expect(writes.join("")).toContain(
      "Installs for claude and codex, into .agents, .claude and .codex.",
    );
  });

  test("writes the manifest with the harnesses it chose and nothing else", async () => {
    const cwd = await mkdtemp(join(scratch, "aireg-init-"));
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    await run(context(cwd, ["--for", "claude,codex"], []));
    expect(await readFile(join(cwd, ".registry", "manifest.yml"), "utf8")).toBe(
      "harnesses:\n  - claude\n  - codex\nregistries: {}\nartifacts: []\n",
    );
  });

  test("refuses a --publish-to that names no namespace before it writes anything", async () => {
    const cwd = await mkdtemp(join(scratch, "aireg-init-"));
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "user"));
    const argv = ["--registry", "../acme-registry", "--publish-to", "nonsense"];
    await expect(run(context(cwd, argv, []))).rejects.toMatchObject({
      code: ErrorCode.Usage,
      message: '--publish-to takes <registry>/<namespace>, not "nonsense".',
    });
    expect(existsSync(join(cwd, ".registry"))).toBe(false);
  });

  test.for(["-g", "--user"])("explains that %s needs no setup", async (flag, { tmp }) => {
    const error = await run(context(tmp, [flag], [])).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: "Your user scope needs no setup.",
      code: ErrorCode.Usage,
      hint: "Install into it with `aireg add -g`.",
    });
  });
});
