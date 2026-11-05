import { join } from "node:path";
import { expect } from "vitest";
import { gitRegistry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("console");

test("console prints state its schema describes", async ({ aireg, git, tmp }) => {
  // Installed artifacts, an account and a job with a finished run fill every view.
  const repo = await gitRegistry(git, join(tmp, "kit"));
  await aireg(["init", "--for", "claude-code"]);
  const added = await aireg(["add", `file://${repo}`, "--as", "kit"]);
  expect(added.code, added.stderr).toBe(0);
  const job = await aireg(["job", "add", "--registry", "kit"]);
  expect(job.code, job.stderr).toBe(0);
  await expect
    .poll(
      async () =>
        (await aireg(["job", "runs", "--json"])).json<{ runs: { state: string }[] }>().data?.runs[0]
          ?.state,
      { interval: 100, timeout: 20_000 },
    )
    .toBe("succeeded");

  expect(await contract.violations(aireg, ["console"], "console")).toBe("");
  expect(contract.unchecked()).toEqual([]);
}, 60_000);
