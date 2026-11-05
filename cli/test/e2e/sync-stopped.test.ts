import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { leaseKey } from "#core/lease/location.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { BIN } from "#test/kit/run.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";

describe("a sync whose run is canceled before it finishes", () => {
  test("fails, naming why, instead of reporting the scope in sync", async ({
    aireg,
    home,
    project,
    tmp,
  }) => {
    const market = join(tmp, "market");
    await registry(market).skill("acme/lint@1.0.0").write();
    await writeManifestIn(
      project,
      `targets:\n  - claude\nregistries:\n  kit: ${JSON.stringify(market)}\nartifacts:\n  - kit/acme/skill/lint\n`,
    );
    expect((await aireg(["install"])).code).toBe(0);
    await registry(market).skill("acme/lint@1.0.0").skill("acme/lint@1.1.0").write();
    // Held from another host, so the run waits on it rather than taking it over.
    const lease = join(
      project,
      ".registry",
      "leases",
      `${leaseKey({ lock: lockPath(project) })}.lease`,
    );
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

    const child = spawn(process.execPath, [BIN, "sync"], {
      cwd: project,
      env: { ...process.env, ...home.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

    const running = async () => {
      const listed = (await aireg(["job", "runs", "--json"])).json<{
        runs: { id: string; state: string }[];
      }>();
      return listed.data?.runs.find((run) => run.state === "running")?.id;
    };
    await expect.poll(running, { interval: 200, timeout: 20_000 }).toBeDefined();
    expect((await aireg(["job", "cancel", (await running()) as string])).code).toBe(0);

    expect(await exited).toBe(1);
    expect(stdout).not.toContain("In sync");
    expect(stderr).toContain("Could not finish syncing kit: canceled.");
  });
});
