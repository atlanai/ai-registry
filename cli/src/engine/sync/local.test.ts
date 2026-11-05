import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { exists } from "#core/fs/tree.ts";
import { roots as makeRoots, type Roots, stagingDir } from "#core/store/paths.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody, writeSpecRoot } from "#test/kit/spec-root.ts";
import { applyLocal } from "./local.ts";
import { scan } from "./scan.ts";

const COMMON: CommonOptions = {
  scope: "project",
  targets: ["claude-code"],
  select: undefined,
  yes: true,
  all: false,
  dryRun: false,
  frozen: false,
  force: false,
  copy: false,
};

let dir: string;
let project: string;
let roots: Roots;

beforeAll(() => registerBuiltinAdapters());

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "aireg-local-")));
  vi.stubEnv("AIREG_HOME", join(dir, "aireg"));
  vi.stubEnv("AIREG_USER_SCOPE", join(dir, "user"));
  const kit = join(dir, "kit");
  await writeSpecRoot(kit, [
    {
      namespace: "kit",
      kind: "skill",
      name: "lint",
      versions: [{ version: "1.0.0", files: { "SKILL.md": skillBody("lint") } }],
    },
  ]);
  project = join(dir, "project");
  await writeManifestIn(
    project,
    `registries:\n  kit: ${kit}\nartifacts:\n  - kit/kit/skill/lint\n`,
  );
  roots = makeRoots("project", project);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await chmod(join(project, ".claude"), 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function sync() {
  const loaded = await load(COMMON, project);
  const found = await scan(loaded, COMMON);
  return applyLocal(loaded, COMMON, found, new Set(["lint"]), new Map(), false, () => {});
}

describe("applyLocal", () => {
  test("says where it moved a person's own folder that stood on a recorded link", async () => {
    await sync();
    const link = join(project, ".claude", "skills", "lint");
    await rm(link);
    await mkdir(link);
    await writeFile(join(link, "SKILL.md"), "mine\n");

    const { notices } = await sync();

    expect(notices).toContainEqual({
      message: expect.stringMatching(/^Moved your folder \.claude\/skills\/lint to .+\.$/),
    });
  });

  test("cleans what a crashed run left before writing a journal of its own", async () => {
    const orphan = join(stagingDir(), "kit", "kit", "skill", "gone", "0");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "SKILL.md"), "left behind\n");
    await mkdir(dirname(roots.applyJournal), { recursive: true });
    await writeFile(roots.applyJournal, JSON.stringify({ writes: [orphan] }));

    await sync();

    expect(await exists(orphan)).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "refuses a target folder it cannot write into before writing anything",
    async () => {
      await mkdir(join(project, ".claude"), { recursive: true });
      await chmod(join(project, ".claude"), 0o555);

      await expect(sync()).rejects.toThrow(/Cannot write into the folder for claude/);
      expect(await exists(roots.applyJournal)).toBe(false);
    },
  );
});
