import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect } from "vitest";
import { withLease } from "#core/lease/lease.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { manifest } from "#test/kit/builders/manifest.ts";
import { commandContext } from "#test/kit/command.ts";
import { homeTest } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";
import { run } from "./registry.ts";

describe("registry remove", () => {
  homeTest("writes the manifest only while it holds the scope lease", async ({ project }) => {
    const path = await manifest()
      .registry("acme", "github.com/acme/skills")
      .registry("tools", "github.com/acme/tools")
      .write(project);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lease = withLease({ scope: "project", lock: lockPath(project) }, {}, async () => {
      entered();
      await held;
    });
    await holding;

    const removing = run(commandContext(["remove", "acme"], { cwd: project }));
    await sleep(300);
    expect(Object.keys((await readManifest(path)).registries)).toEqual(["acme", "tools"]);

    release();
    await lease;
    await removing;
    expect(Object.keys((await readManifest(path)).registries)).toEqual(["tools"]);
  });
});
