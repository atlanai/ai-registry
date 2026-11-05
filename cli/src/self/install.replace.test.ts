import { spawn } from "node:child_process";
import { readFile, readlink, stat } from "node:fs/promises";
import { describe, expect } from "vitest";
import { launchArgv } from "#core/release/launch.ts";
import { currentLink, shimPath, versionBin } from "#core/release/layout.ts";
import { standaloneShim } from "#core/release/shim.ts";
import { test } from "#test/kit/fixtures.ts";
import { installBinary, installedVersion } from "./install.ts";

/**
 * Announces itself, then blocks on stdin: the announcement is what proves the
 * kernel has already exec'd this inode before the replacement lands.
 */
function blockingScript(version: string): Uint8Array {
  return new TextEncoder().encode(`#!/bin/sh\necho running\nread -r _line\necho "${version}"\n`);
}

function versionScript(version: string): Uint8Array {
  return new TextEncoder().encode(`#!/bin/sh\necho "${version}"\n`);
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

describe.skipIf(process.platform === "win32")("replacing a running executable", () => {
  test("renames a new inode into place and re-execs it", async ({ tmp }) => {
    const home = tmp;
    const env = { AIREG_HOME: home };

    const bin = await installBinary("0.1.0", blockingScript("0.1.0"), env);
    expect(bin).toBe(versionBin("0.1.0", env));
    const before = await stat(bin);

    // Hold the executable open the way the running CLI does.
    const running = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    let printed = "";
    const started = new Promise<void>((resolve) => {
      running.stdout.on("data", (chunk: Buffer) => {
        printed += chunk.toString();
        if (printed.includes("running")) resolve();
      });
    });
    const finished = new Promise<void>((resolve) => running.on("close", () => resolve()));
    await started;

    // Same version, same path: this is the case that would otherwise try to
    // write through a file the kernel is executing.
    await installBinary("0.1.0", versionScript("0.1.1"), env);
    const after = await stat(bin);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o111).not.toBe(0);

    running.stdin.end("go\n");
    await finished;
    // The old inode is still what that process was executing.
    expect(printed.trim().split("\n").at(-1)).toBe("0.1.0");

    const launch = launchArgv(bin, []);
    expect(await run(launch.command, launch.args)).toBe("0.1.1");
  });

  test("swings current and the shim to a newly installed version", async ({ tmp }) => {
    const home = tmp;
    const env = { AIREG_HOME: home };

    await installBinary("0.1.0", versionScript("0.1.0"), env);
    await installBinary("0.2.0", versionScript("0.2.0"), env);

    expect(await readlink(currentLink(env))).toBe("0.2.0");
    // The shim is the stable name on PATH and needs no Node to reach the target.
    expect(await run(shimPath(env), [], { PATH: process.env.PATH, ...env })).toBe("0.2.0");
  });

  test("writes the same shim the installer writes, so neither clobbers the other", async ({
    tmp,
  }) => {
    const home = tmp;
    const env = { AIREG_HOME: home };

    await installBinary("0.1.0", versionScript("0.1.0"), env);
    expect(await readFile(shimPath(env), "utf8")).toBe(standaloneShim());
  });
});

describe("launchArgv", () => {
  test("spawns a standalone executable directly, and a script through its runtime", () => {
    expect(launchArgv("/home/u/.aireg/cli/0.2.0/aireg", ["--version"])).toEqual({
      command: "/home/u/.aireg/cli/0.2.0/aireg",
      args: ["--version"],
    });
    expect(launchArgv("/repo/cli/bin/aireg.mjs", ["x"], "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: ["--disable-warning=ExperimentalWarning", "/repo/cli/bin/aireg.mjs", "x"],
    });
    expect(launchArgv("/repo/cli/src/main.ts", [], "/usr/bin/node").args).toContain(
      "--experimental-strip-types",
    );
  });
});

describe.runIf(process.platform === "win32")("replacing a running executable on Windows", () => {
  test("moves the running copies aside and puts the new one on PATH", async ({ tmp }) => {
    const env = { AIREG_HOME: tmp };
    // Any real executable will do; Node's own is at hand.
    const bytes = new Uint8Array(await readFile(process.execPath));
    const bin = await installBinary("0.1.0", bytes, env);
    expect(await installedVersion(env)).toBe("0.1.0");

    const running = [bin, shimPath(env)].map((path) =>
      spawn(path, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await installBinary("0.1.0", bytes, env);
      await installBinary("0.2.0", bytes, env);
      expect(await installedVersion(env)).toBe("0.2.0");
      expect(await run(shimPath(env), ["-e", "console.log('ran')"])).toBe("ran");
    } finally {
      // Windows keeps a running file from being deleted, so the cleanup waits for both.
      await Promise.all(
        running.map((child) => {
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.kill();
          return exited;
        }),
      );
    }
  });
});
