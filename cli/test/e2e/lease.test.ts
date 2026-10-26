import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { leaseKey } from "#core/lease.ts";
import { gitRegistry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { BIN } from "#test/kit/run.ts";
import { lockPath } from "#test/kit/scope.ts";

/** A project that declares and installs a git registry, so `update` and `install` have work. */
const test = base.extend("leased", async ({ aireg, git, project, tmp }) => {
  const repo = await gitRegistry(git, join(tmp, "kit"));
  await aireg(["init", "--for", "claude-code"]);
  const added = await aireg(["add", `file://${repo}`]);
  expect(added.code, added.stderr).toBe(0);
  // In the project, so a writer with another AIREG_HOME takes the same lease.
  const leases = join(project, ".registry", "leases");
  return {
    address: `file://${repo}`,
    leases,
    held: async () =>
      (await readdir(leases).catch(() => [])).filter((entry) => entry.endsWith(".lease")),
  };
});

describe("a scope lease", () => {
  // Ctrl-C to a process group is POSIX.
  test.skipIf(process.platform === "win32")(
    "is handed back when the command holding it is interrupted",
    async ({ home, project, tmp, leased }) => {
      // A git that never answers holds the command inside its lease.
      const bin = join(tmp, "hung-git");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
      await chmod(join(bin, "git"), 0o755);

      const child = spawn(process.execPath, [BIN, "update"], {
        cwd: project,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...home.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once("exit", (_code, signal) => resolve(signal)),
      );
      await expect.poll(leased.held, { interval: 100, timeout: 10_000 }).toHaveLength(1);

      // Ctrl-C reaches the whole process group, git included.
      process.kill(-(child.pid as number), "SIGINT");
      expect(await exited).toBe("SIGINT");
      expect(await leased.held()).toEqual([]);
    },
  );

  test.for(["install", "registry add"])(
    "names its holder while %s waits for it",
    async (command, { home, project, leased }) => {
      const lease = join(leased.leases, `${leaseKey({ lock: lockPath(project) })}.lease`);
      await mkdir(lease, { recursive: true });
      await writeFile(
        join(lease, "meta.json"),
        JSON.stringify({
          id: "held",
          scope: "project",
          lock: "",
          host: "",
          pid: 4242,
          acquiredAtMs: 0,
        }),
      );
      const args = command === "install" ? ["install"] : ["registry", "add", leased.address];
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: project,
        env: { ...process.env, ...home.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let announce!: () => void;
      let fail!: (error: Error) => void;
      let announced = false;
      const waiting = new Promise<void>((resolve, reject) => {
        announce = resolve;
        fail = reject;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (/Waiting for aireg \(pid 4242\)/.test(stderr)) {
          announced = true;
          announce();
        }
      });
      // Drain both pipes even when an assertion fails.
      child.stdout.resume();
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", (error) => {
          fail(error);
          reject(error);
        });
        child.once("close", (code) => {
          if (!announced) fail(new Error(`Command exited before naming its holder: ${stderr}`));
          resolve(code);
        });
      });
      exited.catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Command did not finish: ${stderr}`)), 30_000);
      });
      try {
        await Promise.race([waiting, deadline]);
        await rm(lease, { recursive: true, force: true });
        expect(await Promise.race([exited, deadline]), stderr).toBe(0);
        expect(stderr).toContain("aireg unlock");
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited.catch(() => {});
        await rm(lease, { recursive: true, force: true });
      }
    },
  );
});
