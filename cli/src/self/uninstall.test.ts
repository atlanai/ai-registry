import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { footprint } from "./uninstall.ts";

// Never the real CLI: its path is wherever this machine happens to run it from.
const machine = vi.hoisted(() => ({ entry: undefined as string | undefined }));

vi.mock("#core/release/launch.ts", () => ({ runningEntry: () => machine.entry }));

beforeEach(() => {
  machine.entry = undefined;
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
