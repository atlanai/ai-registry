import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { gitRegistry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("job");

// A daemon stopped mid-run leaves a run that can be retried; the stand-in git is a shell script.
test.skipIf(process.platform === "win32")(
  "each job action prints data its schema describes",
  async ({ aireg, git, tmp }) => {
    const repo = await gitRegistry(git, join(tmp, "kit"));
    await aireg(["init", "--for", "claude-code"]);
    const added = await aireg(["add", `file://${repo}`, "--as", "kit"]);
    expect(added.code, added.stderr).toBe(0);
    const bin = join(tmp, "hung-git");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    await chmod(join(bin, "git"), 0o755);

    const check = async (args: string[], action: string, env?: NodeJS.ProcessEnv) =>
      expect(
        await contract.violations(
          (argv, options) => aireg(argv, { ...options, ...(env === undefined ? {} : { env }) }),
          ["job", ...args],
          action,
        ),
      ).toBe("");
    // The daemon this starts inherits the git that never answers, so the job's first run hangs.
    await check(["add", "--registry", "kit", "--name", "kit-sync"], "add", {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    await check(["list"], "list");
    await check(["disable", "kit-sync"], "disable");
    await check(["enable", "kit-sync"], "enable");
    await check(["pause"], "pause");
    await check(["resume"], "resume");
    await check(["start", "kit-sync"], "start");
    await check(["runs", "--job", "kit-sync"], "runs");

    const started = await aireg(["job", "start", "kit-sync", "--json"]);
    const runId = started.json<{ run: { id: string } }>().data?.run.id ?? "";
    expect(runId).toMatch(/^run_/);
    const stopped = await aireg(["daemon", "stop"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    await check(["runs", runId], "runs");
    await check(["retry", runId], "retry");
    await check(["cancel", runId], "cancel");
    await check(["remove", "kit-sync"], "remove");
    expect(contract.unchecked()).toEqual([]);
  },
  60_000,
);
