import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, test } from "#test/kit/fixtures.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";

/** `lint` installed by name and `format` and `notes` through their namespace; `extra` is not installed. */
async function installed(aireg: Aireg, project: string, market: string): Promise<void> {
  await registry(market, { name: "acme", slug: "acme" })
    .skill("acme/lint@1.0.0")
    .skill("acme/extra@1.0.0")
    .skill("tools/format@1.0.0")
    .skill("tools/notes@1.0.0")
    .write();
  // What `init --for claude` and `registry add` write, without running either.
  await writeManifestIn(
    project,
    `targets:\n  - claude\nregistries:\n  acme: ${JSON.stringify(market)}\nartifacts: []\n`,
  );
  for (const address of ["acme/skill/lint", "acme/tools"]) {
    const added = await aireg(["add", address, "-y"]);
    expect(added.code, added.stderr).toBe(0);
  }
}

/** Rewrites the registry's index to list only what `keep` passes, as a truncated publish would. */
async function listOnly(market: string, keep: (name: string) => boolean): Promise<void> {
  const path = join(market, "index.json");
  const index = JSON.parse(await readFile(path, "utf8")) as { entries: { name: string }[] };
  index.entries = index.entries.filter((entry) => keep(entry.name));
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);
}

const skill = (project: string, name: string) =>
  join(project, ".claude", "skills", name, "SKILL.md");

async function lockedNames(project: string): Promise<string[]> {
  const lock = parse(await readFile(lockPath(project), "utf8")) as {
    artifacts: Record<string, unknown>;
  };
  return Object.keys(lock.artifacts).sort();
}

describe("a registry that stops listing an installed artifact", () => {
  test("keeps it when another is added or it is updated, and names the command that removes it", async ({
    aireg,
    project,
    tmp,
  }) => {
    const market = join(tmp, "market");
    await installed(aireg, project, market);
    await listOnly(market, (name) => name !== "notes");

    // Adding another artifact reads the registry again, which must not take this one out.
    const add = await aireg(["add", "acme/skill/extra", "-y"]);
    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain('acme no longer lists "tools/notes", so it was kept.');
    expect(add.stderr).toContain("Run `aireg remove tools/notes` to take it out.");
    expect(existsSync(skill(project, "notes"))).toBe(true);
    expect(existsSync(skill(project, "extra"))).toBe(true);

    const update = await aireg(["update", "-y"]);
    expect(update.code).toBe(1);
    expect(update.stderr).toContain('acme no longer lists "tools/notes", so it was kept.');
    expect(existsSync(skill(project, "notes"))).toBe(true);
    expect(await lockedNames(project)).toEqual(["extra", "lint", "tools/format", "tools/notes"]);

    // The hint, run as printed, still takes it out.
    const removed = await aireg(["remove", "tools/notes", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(skill(project, "notes"))).toBe(false);
    expect(await lockedNames(project)).toEqual(["extra", "lint", "tools/format"]);
    const again = await aireg(["update", "-y"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).not.toContain("no longer lists");
  });

  test("keeps everything when the listing is empty", async ({ aireg, project, tmp }) => {
    const market = join(tmp, "market");
    await installed(aireg, project, market);
    await listOnly(market, () => false);

    const update = await aireg(["update", "-y"]);
    expect(update.code).toBe(1);
    expect(update.stderr).toContain('acme lists no artifacts now, so "lint" was kept');
    expect(update.stderr).toContain(
      "Run `aireg remove lint`, `aireg remove tools/format` and `aireg remove tools/notes` to take them out.",
    );
    for (const name of ["lint", "format", "notes"]) {
      expect(existsSync(skill(project, name))).toBe(true);
    }
    expect(await lockedNames(project)).toEqual(["lint", "tools/format", "tools/notes"]);
  });

  test("is left for you by sync and by a background job", async ({ aireg, project, tmp }) => {
    const market = join(tmp, "market");
    await installed(aireg, project, market);
    await listOnly(market, (name) => name !== "notes");
    const synced = await aireg(["sync"]);
    expect(synced.code).toBe(3);
    expect(`${synced.stdout}${synced.stderr}`).toContain("acme no longer lists it");
    expect(existsSync(skill(project, "notes"))).toBe(true);

    const added = await aireg(["job", "add", "--registry", "acme"]);
    expect(added.code, added.stderr).toBe(0);
    const state = async () => {
      const runs = JSON.parse((await aireg(["job", "runs", "--json"])).stdout) as {
        data: { runs: { state: string }[] };
      };
      return runs.data.runs[0]?.state;
    };
    await expect.poll(state, { interval: 200, timeout: 20_000 }).toBe("attention");
    expect(existsSync(skill(project, "notes"))).toBe(true);
    expect(await lockedNames(project)).toEqual(["lint", "tools/format", "tools/notes"]);
  });
});
