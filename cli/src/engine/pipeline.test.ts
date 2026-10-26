import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { formatLock } from "#core/lock.ts";
import { Printer } from "#core/output.ts";
import type { Plan } from "#core/plan/model.ts";
import { parseRef } from "#core/ref.ts";
import { type Roots, roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { manifestPath, writeManifestIn } from "#test/kit/scope.ts";
import { skillBody, writeSpecRoot } from "#test/kit/spec-root.ts";
import type { CommonOptions } from "./options.ts";
import { locate, run } from "./pipeline.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

const failure = vi.hoisted(() => ({ afterRecord: false }));

vi.mock("#core/plan/apply.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#core/plan/apply.ts")>()),
  apply: vi.fn(async (plan: Plan, at: Roots) => {
    const record = plan.actions.find((action) => action.kind === "record");
    if (failure.afterRecord && record?.kind === "record") {
      await writeFile(at.lock, formatLock(record.lock));
    }
    throw new Error("ENOSPC: no space left on device");
  }),
}));

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

beforeAll(() => registerBuiltinAdapters());

afterEach(async () => {
  vi.unstubAllEnvs();
});

describe("run", () => {
  async function failedAdd(): Promise<{ project: string; before: string }> {
    const dir = await mkdtemp(join(scratch, "aireg-pipeline-"));
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
    const project = join(dir, "project");
    const before = `# ours\nregistries:\n  kit: ${kit}\nartifacts: []\n`;
    await writeManifestIn(project, before);
    const quiet = { write: () => true, isTTY: false };
    const printer = new Printer({ format: "json", out: quiet, err: quiet });

    await expect(
      run(
        roots("project", project),
        COMMON,
        printer,
        project,
        { plan() {}, step() {} },
        ({ manifest }) => {
          manifest.artifacts.push(parseRef("kit/kit/skill/lint"));
          return {};
        },
      ),
    ).rejects.toThrow(/ENOSPC/);
    return { project, before };
  }

  test("leaves the manifest as it was when apply fails before recording the lock", async () => {
    failure.afterRecord = false;
    const { project, before } = await failedAdd();
    expect(await readFile(manifestPath(project), "utf8")).toBe(before);
  });

  test("keeps the manifest edit when the lock already records what it asked for", async () => {
    failure.afterRecord = true;
    const { project } = await failedAdd();
    expect(await readFile(manifestPath(project), "utf8")).toContain("- kit/kit/skill/lint");
  });
});

describe("locate", () => {
  test("never makes the home folder a project from a .registry left there", async () => {
    const home = await realpath(await mkdtemp(join(scratch, "aireg-home-")));
    const elsewhere = join(home, "scope");
    vi.stubEnv("HOME", home);
    vi.stubEnv("AIREG_USER_SCOPE", elsewhere);
    try {
      await mkdir(join(home, ".registry"), { recursive: true });
      await writeFile(join(home, ".registry", "manifest.yml"), "artifacts: []\n");
      await mkdir(join(home, "notes"));
      expect(locate(undefined, join(home, "notes"))).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
