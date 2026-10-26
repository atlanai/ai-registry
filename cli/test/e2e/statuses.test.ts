import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, test as base } from "#test/kit/fixtures.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";

/**
 * One namespace per status: each holds an artifact whose newest version has that status beside
 * an active one, and `only`, whose one version has it.
 */
async function publish(root: string): Promise<void> {
  const built = registry(root, { name: "acme", slug: "acme" });
  built
    .skill("dep/lint@1.0.0")
    .skill("dep/lint@1.1.0")
    .status("dep/lint@1.1.0", "deprecated", "use fmt");
  built.skill("dep/only@1.0.0").status("dep/only@1.0.0", "deprecated", "use fmt");
  for (const [namespace, status] of [
    ["drf", "draft"],
    ["pen", "pending_review"],
    ["blk", "blocked"],
  ] as const) {
    built.skill(`${namespace}/lint@1.0.0`).skill(`${namespace}/lint@1.1.0`);
    built.status(`${namespace}/lint@1.1.0`, status, "not yet");
    built.skill(`${namespace}/only@1.0.0`).status(`${namespace}/only@1.0.0`, status, "not yet");
  }
  await built.write();
}

const test = base
  // Read by every test and changed by none, so it is written once.
  .extend("market", { scope: "file" }, async ({ fileTmp }) => {
    const market = join(fileTmp, "market");
    await publish(market);
    return market;
  })
  .extend("added", async ({ aireg, market, project }) => {
    await declare(project, market);
    return aireg;
  });

/** What `init --for claude` and `registry add <market> --as acme` write, without running either. */
const declare = (project: string, market: string) =>
  writeManifestIn(
    project,
    `targets:\n  - claude\nregistries:\n  acme: ${JSON.stringify(market)}\nartifacts: []\n`,
  );

async function versions(project: string): Promise<Record<string, string | undefined>> {
  const lock = parse(await readFile(lockPath(project), "utf8")) as {
    artifacts: Record<string, { version?: string }>;
  };
  return Object.fromEntries(
    Object.entries(lock.artifacts).map(([name, row]) => [name, row.version]),
  );
}

const add = (aireg: Aireg, address: string) => aireg(["add", address, "-y"]);

describe("a deprecated version", () => {
  test("installs as latest, with a warning naming the reason", async ({ added, project }) => {
    const ran = await add(added, "acme/dep/skill/only");
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("dep/only 1.0.0 is deprecated (use fmt).");
    expect(await versions(project)).toEqual({ only: "1.0.0" });
  });

  test("installs pinned, with the warning", async ({ added, project }) => {
    const ran = await add(added, "acme/dep/skill/lint@1.1.0");
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("dep/lint 1.1.0 is deprecated (use fmt).");
    expect(await versions(project)).toEqual({ lint: "1.1.0" });
  });

  test("is not latest beside an active version, and installs with its namespace", async ({
    added,
    project,
  }) => {
    const ran = await add(added, "acme/dep");
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain("dep/only 1.0.0 is deprecated (use fmt).");
    expect(ran.stderr).not.toContain("dep/lint");
    expect(await versions(project)).toEqual({ "dep/lint": "1.0.0", "dep/only": "1.0.0" });
    // Said once, when it lands: a run that leaves it as it is says nothing more.
    const again = await added(["install"]);
    expect(again.stderr).not.toContain("deprecated");
  });
});

describe.each([
  ["draft", "drf", "is a draft"],
  ["pending_review", "pen", "is pending review"],
])("a %s version", (_status, namespace, words) => {
  test("is never latest", async ({ added, project }) => {
    const ran = await add(added, `acme/${namespace}/skill/lint`);
    expect(ran.code, ran.stderr).toBe(0);
    expect(await versions(project)).toEqual({ lint: "1.0.0" });
    const only = await add(added, `acme/${namespace}/skill/only`);
    expect(only.code).toBe(1);
    expect(only.stderr).toContain(
      `${namespace}/only 1.0.0 ${words} (not yet), so nothing was installed.`,
    );
  });

  test("installs pinned, with a warning", async ({ added, project }) => {
    const ran = await add(added, `acme/${namespace}/skill/lint@1.1.0`);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toContain(
      `${namespace}/lint 1.1.0 ${words} (not yet), and installs only because it is pinned.`,
    );
    expect(await versions(project)).toEqual({ lint: "1.1.0" });
  });

  test("is left out of a namespace install", async ({ added, project }) => {
    const ran = await add(added, `acme/${namespace}`);
    expect(ran.code, ran.stderr).toBe(0);
    expect(await versions(project)).toEqual({ [`${namespace}/lint`]: "1.0.0" });
  });
});

describe("a blocked version", () => {
  test("is never latest", async ({ added, project }) => {
    const ran = await add(added, "acme/blk/skill/lint");
    expect(ran.code, ran.stderr).toBe(0);
    expect(await versions(project)).toEqual({ lint: "1.0.0" });
  });

  test("is left out of a namespace install", async ({ added, project }) => {
    const ran = await add(added, "acme/blk");
    expect(ran.code, ran.stderr).toBe(0);
    expect(await versions(project)).toEqual({ "blk/lint": "1.0.0" });
  });
});

describe("a sync that pulls a deprecated version", () => {
  test("says so, as a background job does", async ({ aireg, project, tmp }) => {
    const market = join(tmp, "market");
    await registry(market, { name: "acme", slug: "acme" }).skill("ops/lint@1.0.0").write();
    await declare(project, market);
    expect((await add(aireg, "acme/ops/skill/lint")).code).toBe(0);
    await registry(market, { name: "acme", slug: "acme" })
      .skill("ops/lint@1.0.0")
      .skill("ops/lint@1.1.0")
      .status("ops/lint@1.0.0", "deprecated")
      .status("ops/lint@1.1.0", "deprecated", "use fmt")
      .write();
    const synced = await aireg(["sync"]);
    expect(synced.code, synced.stderr).toBe(0);
    expect(`${synced.stdout}${synced.stderr}`).toContain("ops/lint 1.1.0 is deprecated (use fmt).");
    expect(await versions(project)).toEqual({ lint: "1.1.0" });
  });
});
