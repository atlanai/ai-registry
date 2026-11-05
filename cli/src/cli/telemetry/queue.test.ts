import { afterEach, describe, expect, vi } from "vitest";
import type { spawnDetached } from "#core/process.ts";
import { Printer } from "#core/term/printer.ts";
import { test } from "#test/kit/fixtures.ts";
import { trackSearch } from "./events.ts";
import { flushTelemetry, noticeFirst } from "./queue.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("noticeFirst", () => {
  test("shows once per home, and the run that shows it sends nothing", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    vi.stubEnv("AIREG_TELEMETRY_URL", "https://collector.example/t");
    vi.stubEnv("DO_NOT_TRACK", "");
    vi.stubEnv("AIREG_DISABLE_TELEMETRY", "");
    let err = "";
    const printer = new Printer({
      err: {
        isTTY: false,
        write: (chunk: string) => {
          err += chunk;
        },
      },
    });
    const $spawn = vi.fn(() => ({
      on: () => {},
      stdin: { on: () => {}, end: (_: string, done: () => void) => done() },
    }));
    const run = async () => {
      trackSearch("lint", 1, undefined, []);
      await noticeFirst(printer);
      await flushTelemetry("/bin/aireg", $spawn as unknown as typeof spawnDetached);
    };

    await run();
    expect(err).toContain("notice: aireg collects anonymous usage data");
    expect($spawn).not.toHaveBeenCalled();

    err = "";
    await run();
    expect(err).toBe("");
    expect($spawn).toHaveBeenCalledTimes(1);
  });
});
