import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "./process.ts";

const node = (script: string) => [process.execPath, ["-e", script]] as const;

describe.skipIf(process.platform === "win32")("exec", () => {
  it("reports a missing binary as 127", async () => {
    const ran = await exec("aireg-test-no-such-binary", [], { timeoutMs: 5_000 });
    expect(ran.code).toBe(127);
    expect(ran.stderr).toBe("aireg-test-no-such-binary was not found.");
  });

  it("reports a timeout as 124, not as a missing binary", async () => {
    const [command, args] = node("console.error('started'); setTimeout(() => {}, 10_000)");
    const ran = await exec(command, args, { timeoutMs: 200 });
    expect(ran.code).toBe(124);
    expect(ran.stderr).toBe(`started\n${command} did not finish within 200 ms.`);
  });

  it("reports a signal as 128 plus its number", async () => {
    const ran = await exec("sh", ["-c", "kill -KILL $$"], { timeoutMs: 5_000 });
    expect(ran.code).toBe(137);
    expect(ran.stderr).toBe("sh was stopped by SIGKILL.");
  });

  it("reports output past its limit instead of a cut-off success", async () => {
    const [command, args] = node("process.stdout.write('x'.repeat(4096))");
    const ran = await exec(command, args, { timeoutMs: 5_000, maxOutputBytes: 1024 });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toBe(`${command} wrote more than 1024 bytes, so it was stopped.`);
  });

  it("takes more than a mebibyte of output by default", async () => {
    const [command, args] = node("process.stdout.write('x'.repeat(2 * 1024 * 1024))");
    const ran = await exec(command, args, { timeoutMs: 10_000 });
    expect(ran).toMatchObject({ code: 0, stderr: "" });
    expect(ran.stdout).toHaveLength(2 * 1024 * 1024);
  });

  it("never runs a command found through a relative PATH entry, as in a registry checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aireg-path-"));
    try {
      await mkdir(join(dir, "bin"));
      await writeFile(join(dir, "bin", "planted"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
      const ran = await exec("planted", [], {
        timeoutMs: 5_000,
        cwd: dir,
        env: { ...process.env, PATH: `bin${delimiter}${process.env.PATH ?? ""}` },
      });
      expect(ran.code).toBe(127);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs nothing when no folder on PATH is absolute", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aireg-path-"));
    try {
      const marker = join(dir, "planted.ran");
      // A redirect, which needs nothing on PATH, so the marker shows any run.
      await writeFile(join(dir, "planted"), `#!/bin/sh\n: > "${marker}"\n`, { mode: 0o755 });
      const ran = await exec("planted", [], { timeoutMs: 5_000, cwd: dir, env: { PATH: "." } });
      expect(ran).toEqual({
        code: 127,
        stdout: "",
        stderr: "No folder on PATH is absolute, so aireg runs no program from it.",
      });
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs a command named by its absolute path when no folder on PATH is absolute", async () => {
    const [command, args] = node("process.stdout.write(String(process.env.PATH))");
    const ran = await exec(command, args, { timeoutMs: 10_000, env: { PATH: "." } });
    expect(ran).toEqual({ code: 0, stdout: "undefined", stderr: "" });
  });
});
