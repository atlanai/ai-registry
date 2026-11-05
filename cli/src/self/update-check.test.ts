import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import type { spawnDetached } from "#core/process.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";
import { test } from "#test/kit/fixtures.ts";
import { readUpdateCache } from "./update-cache.ts";
import { scheduleUpdateCheck, skipUpdateCheck } from "./update-check.ts";

// The stamp is build-time only, so a test stands one in.
vi.mock("#core/release/stamp.ts", () => ({ releaseStamp: () => ({}) as ReleaseStamp }));

describe("skipUpdateCheck", () => {
  test("skips CI, json, non-tty, and opt-out flags", () => {
    expect(skipUpdateCheck({}, true, true)).toBe(true);
    expect(skipUpdateCheck({}, false, false)).toBe(true);
    expect(skipUpdateCheck({ CI: "true" }, false, true)).toBe(true);
    expect(skipUpdateCheck({ AIREG_DISABLE_UPDATE_CHECK: "1" }, false, true)).toBe(true);
    expect(skipUpdateCheck({}, false, true)).toBe(false);
  });
});

describe("readUpdateCache", () => {
  test("reads a cache with no minimum", async ({ tmp }) => {
    const home = tmp;
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(join(home, "state", "update-check.json"), '{"checkedAt":1,"latest":"0.1.2"}');
    expect(await readUpdateCache({ AIREG_HOME: home })).toMatchObject({
      checkedAt: 1,
      latest: "0.1.2",
      minimumVersion: undefined,
    });
  });
});

describe("scheduleUpdateCheck", () => {
  test("claims the interval and starts one detached check that it does not wait for", async ({
    tmp,
  }) => {
    const home = tmp;
    const started: unknown[][] = [];
    const $spawn = ((command: string, args: string[], options: unknown) => {
      started.push([command, ...args, options]);
      return Object.assign(new EventEmitter(), { unref: () => {} });
    }) as unknown as typeof spawnDetached;
    const env = { AIREG_HOME: home };
    await scheduleUpdateCheck(env, "/opt/aireg", $spawn);
    await scheduleUpdateCheck(env, "/opt/aireg", $spawn);
    expect(started).toEqual([["/opt/aireg", "--internal-update-check", { env }]]);
  });
});
