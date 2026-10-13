import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { Printer } from "#core/output.ts";
import { test } from "#test/kit/fixtures.ts";
import { type CommandContext, lookup } from "./index.ts";

function context(cwd: string, argv: string[]): CommandContext {
  return {
    argv,
    cwd,
    printer: new Printer({ format: "json", out: { write: () => undefined, isTTY: false } }),
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

describe("skill new --set", () => {
  test.for(["__proto__.polluted=1", "constructor.prototype.polluted=1"])(
    "refuses %s and leaves every object alone",
    async (pair, { tmp }) => {
      const { run } = await ((await lookup("skill", tmp))?.load() ?? Promise.reject());
      await expect(run(context(tmp, ["new", "probe", "--set", pair]))).rejects.toMatchObject({
        code: ErrorCode.Usage,
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
});

describe("skill new without a name", () => {
  test("refuses in a registry when it can't ask, instead of naming it after the folder", async ({
    tmp,
  }) => {
    await writeFile(join(tmp, "registry.json"), "{}\n");
    const namespace = join(tmp, "artifacts", "engineering");
    await mkdir(namespace, { recursive: true });
    const { run } = await ((await lookup("skill", tmp))?.load() ?? Promise.reject());
    await expect(run(context(namespace, ["new"]))).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
    expect(await readdir(namespace)).toEqual([]);
  });
});
