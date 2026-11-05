import { closeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { logPath } from "#core/log/sink.ts";
import { test } from "#test/kit/fixtures.ts";
import { daemonEnv, stderrCapture } from "./lifecycle.ts";

const unix = describe.skipIf(process.platform === "win32");

describe("daemonEnv", () => {
  test("drops the one-command floor opt-out and keeps everything else", () => {
    const env = {
      AIREG_SKIP_MIN_UPDATE: "1",
      AIREG_HOME: "/tmp/home",
      PATH: "/bin",
    };
    expect(daemonEnv(env)).toEqual({ AIREG_HOME: "/tmp/home", PATH: "/bin" });
    expect(env.AIREG_SKIP_MIN_UPDATE).toBe("1");
  });

  test("drops every registry token in any case, so one command's token never outlives that command", () => {
    const env = {
      AIREG_TOKEN_ACME: "synthetic-token",
      AIREG_TOKEN_ACME_PROD: "synthetic-token",
      aireg_token_kit: "synthetic-token",
      AIREG_HOME: "/tmp/home",
    };
    expect(daemonEnv(env)).toEqual({ AIREG_HOME: "/tmp/home" });
  });
});

unix("daemon stderr capture", () => {
  test("opens the capture for appending, keeping what it holds", async ({ home }) => {
    const path = logPath(home.aireg, "daemon-stderr.log");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "small\n");
    const fd = stderrCapture();
    if (fd !== "ignore") closeSync(fd);
    expect(await readFile(path, "utf8")).toBe("small\n");
  });
});
