import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import type { Plan } from "#core/plan/model.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { footprint, unlinkUserScope } from "./uninstall.ts";

// Never the real CLI: its path is wherever this machine happens to run it from.
const machine = vi.hoisted(() => ({
  entry: undefined as string | undefined,
  plan: undefined as Plan | undefined,
  raced: false,
}));

vi.mock("#core/release/launch.ts", () => ({ runningEntry: () => machine.entry }));

// Nor this machine's Windows user PATH, which PowerShell takes a second or two to read.
vi.mock("./windows-path.ts", async (actual) => ({
  ...(await actual<typeof import("./windows-path.ts")>()),
  userPathHas: async () => false,
}));

// A planned teardown, and a first look that saw aireg's link before a folder of yours replaced it.
vi.mock("#core/plan/build/build.ts", async (actual) => {
  const real = await actual<typeof import("#core/plan/build/build.ts")>();
  return {
    ...real,
    build: async (...args: Parameters<typeof real.build>) => machine.plan ?? real.build(...args),
  };
});
vi.mock("#core/plan/apply/link.ts", async (actual) => {
  const real = await actual<typeof import("#core/plan/apply/link.ts")>();
  return {
    ...real,
    guardsOf: async (...args: Parameters<typeof real.guardsOf>) =>
      machine.raced ? new Map() : real.guardsOf(...args),
  };
});

beforeEach(() => {
  machine.entry = undefined;
  machine.plan = undefined;
  machine.raced = false;
});

describe("footprint", () => {
  test("finds nothing on a machine aireg never touched", async ({ home }) => {
    expect(await footprint(home.env)).toEqual({
      links: [],
      startupFiles: [],
      folders: [],
      kept: [],
    });
  });

  // Windows keeps PATH in the registry, which a test must not edit; the CI install covers it.
  test.skipIf(process.platform === "win32")(
    "names the folders and startup files aireg left",
    async ({ home }) => {
      await mkdir(home.aireg, { recursive: true, mode: 0o700 });
      await mkdir(home.scope, { recursive: true });
      await writeFile(join(home.dir, ".profile"), `export EDITOR=vi\n. "$HOME/.aireg/env"\n`);

      const found = await footprint(home.env);

      expect(found).toMatchObject({ links: [], kept: [] });
      expect(found.folders.sort()).toEqual([home.aireg, home.scope].sort());
      expect(found.startupFiles).toEqual([join(home.dir, ".profile")]);
    },
  );

  test("keeps a folder that holds the home, and a CLI aireg did not install", async ({ home }) => {
    machine.entry = "/usr/local/lib/node_modules/aireg/bin/aireg.mjs";
    const env = { ...home.env, AIREG_USER_SCOPE: home.dir };

    const found = await footprint(env);

    expect(found.folders).toEqual([]);
    expect(found.kept).toEqual([home.dir, machine.entry]);
  });

  test("counts a CLI inside aireg's folder as its own", async ({ home }) => {
    machine.entry = join(home.aireg, "cli", "0.1.0", "aireg");
    expect((await footprint(home.env)).kept).toEqual([]);
  });
});

describe("unlinkUserScope", () => {
  test("puts back a folder of yours that replaced a link after the plan was read", async ({
    home,
  }) => {
    const folder = join(home.dir, ".claude", "skills", "lint");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "mine");
    machine.plan = emptyPlan();
    machine.plan.actions.push({
      kind: "unlink",
      name: "lint",
      to: folder,
      link: { target: "claude-code", mode: "symlink" },
    });
    machine.raced = true;

    const done = await unlinkUserScope(home.env);

    expect(done).toEqual({ links: [], kept: [folder] });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("mine");
  });
});
