import { afterEach, describe, expect, vi } from "vitest";
import { readConfig } from "#core/config/repository.ts";
import { ErrorCode } from "#core/errors.ts";
import { Printer } from "#core/term/printer.ts";
import { test } from "#test/kit/fixtures.ts";
import type { CommandContext } from "./command.ts";
import { run } from "./config.ts";

function context(argv: string[], printed: string[] = []): CommandContext {
  return {
    argv,
    cwd: process.cwd(),
    printer: new Printer({
      format: "json",
      out: { write: (chunk: string) => printed.push(chunk) > 0, isTTY: false },
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

describe("config unset", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("clears a setting back to its default", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    await run(context(["set", "defaults.namespace", "acme/engineering"]));
    await run(context(["set", "paused", "true"]));
    const printed: string[] = [];

    await run(context(["unset", "defaults.namespace"], printed));
    await run(context(["unset", "paused"]));

    const config = await readConfig();
    expect(config.defaults.namespace).toBeUndefined();
    expect(config.paused).toBe(false);
    expect(JSON.parse(printed.join(""))).toEqual({
      ok: true,
      data: { key: "defaults.namespace", value: null },
    });
  });

  test("points an empty value at unset", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    await expect(run(context(["set", "defaults.namespace", ""]))).rejects.toMatchObject({
      code: ErrorCode.Usage,
      hint: "Run `aireg config unset defaults.namespace` to clear it.",
    });
  });

  test("names the settings when given no key or an unknown one", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    await expect(run(context(["unset"]))).rejects.toMatchObject({ code: ErrorCode.Usage });
    await expect(run(context(["unset", "nope"]))).rejects.toMatchObject({
      code: ErrorCode.Usage,
      message: 'Unknown setting "nope".',
    });
  });
});
