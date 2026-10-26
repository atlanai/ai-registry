import { access, chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { GitError, git, gitTry, stopGit } from "./exec.ts";

const unix = describe.skipIf(process.platform === "win32");

/**
 * A `git` that starts a helper, as `git fetch` starts `git-remote-http`, and hangs.
 * It writes its own pid before anything else and the helper's once that runs.
 */
async function hungGit(
  bin: string,
): Promise<{ git: () => Promise<number>; helper: () => Promise<number> }> {
  const gitPid = join(bin, "git.pid");
  const helperPid = join(bin, "helper.pid");
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\necho $$ > "${gitPid}"\nsleep 30 &\necho $! > "${helperPid}"\nwait\n`,
  );
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  const pid = (file: string) =>
    vi.waitFor(
      async () => {
        const text = (await readFile(file, "utf8")).trim();
        if (text === "") throw new Error(`${file} is still empty`);
        return Number(text);
      },
      { timeout: 5_000 },
    );
  return { git: () => pid(gitPid), helper: () => pid(helperPid) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

unix("git", () => {
  test("stops the git it started when the run is aborted", async ({ tmp }) => {
    const hung = await hungGit(tmp);
    const controller = new AbortController();
    const started = Date.now();
    const fetching = git(["fetch"], { timeoutMs: 60_000, signal: controller.signal });
    const helper = await hung.helper();
    controller.abort();
    await expect(fetching).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
  });

  // The clock is faked so the timeout fires only once git and its helper are both running.
  test("stops git's helpers too when git times out", async ({ tmp }) => {
    const hung = await hungGit(tmp);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetching = git(["fetch"], { timeoutMs: 60_000 }).catch((reason: unknown) => reason);
      const [gitPid, helper] = [await hung.git(), await hung.helper()];
      vi.advanceTimersByTime(60_000);
      vi.useRealTimers();
      const error = await fetching;
      expect(error).toBeInstanceOf(GitError);
      expect(error).toMatchObject({ failure: "unavailable" });
      await expect.poll(() => alive(gitPid) || alive(helper), { timeout: 5_000 }).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops every running git and its helpers when asked to", async ({ tmp }) => {
    const hung = await hungGit(tmp);
    const fetching = gitTry(["fetch"], { timeoutMs: 60_000 }).catch((reason: unknown) => reason);
    const helper = await hung.helper();
    stopGit();
    await fetching;
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
  });

  it("returns a non-zero exit as data", async () => {
    const attempt = await gitTry(["rev-parse", "--verify", "--quiet", "no-such-ref"], {
      cwd: tmpdir(),
      timeoutMs: 60_000,
    });
    expect(attempt.code).not.toBe(0);
  });

  // Node resolves an empty or relative PATH entry against the child's working folder,
  // which for a fresh checkout is content the registry wrote.
  test("never runs a git planted in the folder it works in", async ({ tmp }) => {
    await writeFile(join(tmp, "git"), `#!/bin/sh\ntouch "${join(tmp, "git.ran")}"\n`);
    await chmod(join(tmp, "git"), 0o755);
    vi.stubEnv("PATH", ["", ".", "bin", process.env.PATH ?? ""].join(delimiter));
    try {
      await gitTry(["--version"], { cwd: tmp, timeoutMs: 60_000 }).catch(() => undefined);
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(access(join(tmp, "git.ran"))).rejects.toThrow();
  });

  test("refuses to run git when no folder on PATH is absolute", async ({ tmp }) => {
    // A redirect, which needs nothing on PATH, so the marker shows any run.
    await writeFile(join(tmp, "git"), `#!/bin/sh\n: > "${join(tmp, "git.ran")}"\n`);
    await chmod(join(tmp, "git"), 0o755);
    vi.stubEnv("PATH", ["", ".", "bin"].join(delimiter));
    try {
      await expect(git(["--version"], { cwd: tmp, timeoutMs: 60_000 })).rejects.toMatchObject({
        failure: "invalid",
        message: "No folder on PATH is absolute, so aireg runs no program from it.",
        hint: "Set PATH to the absolute folders that hold git, then run the command again.",
      });
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(access(join(tmp, "git.ran"))).rejects.toThrow();
  });
});

describe.runIf(process.platform === "win32")("git on Windows", () => {
  // Node stands in for a planted git.
  test("never runs a git planted in the folder it works in", async ({ tmp }) => {
    await copyFile(process.execPath, join(tmp, "git.exe"));
    const attempt = await gitTry(["--version"], { cwd: tmp, timeoutMs: 60_000 });
    expect(attempt.stdout).toMatch(/^git version/);
  });
});
