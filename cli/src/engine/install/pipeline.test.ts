import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { formatLock } from "#core/lock.ts";
import type { Plan } from "#core/plan/model.ts";
import { parseRef } from "#core/ref.ts";
import { type Roots, roots } from "#core/store/paths.ts";
import { locate } from "#engine/scope/locate.ts";
import { commonOptions } from "#test/kit/command.ts";
import { test } from "#test/kit/fixtures.ts";
import { capturedPrinter } from "#test/kit/printer.ts";
import { manifestPath, writeManifestIn } from "#test/kit/scope.ts";
import { skillBody, writeSpecRoot } from "#test/kit/spec-root.ts";
import { runPipeline } from "./pipeline.ts";

const failure = vi.hoisted(() => ({ afterRecord: false }));

vi.mock("#core/plan/apply/apply.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#core/plan/apply/apply.ts")>()),
  apply: vi.fn(async ({ plan, roots: at }: { plan: Plan; roots: Roots }) => {
    const record = plan.actions.find((action) => action.kind === "record");
    if (failure.afterRecord && record?.kind === "record") {
      await writeFile(at.lock, formatLock(record.lock));
    }
    throw new Error("ENOSPC: no space left on device");
  }),
}));

const COMMON = commonOptions({ scope: "project", targets: ["claude-code"], yes: true });

beforeAll(() => registerBuiltinAdapters());

afterEach(async () => {
  vi.unstubAllEnvs();
});

describe("runPipeline", () => {
  async function failedAdd(dir: string): Promise<{ project: string; before: string }> {
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
    const { printer } = capturedPrinter({ format: "json" });

    await expect(
      runPipeline({
        roots: roots("project", project),
        common: COMMON,
        printer,
        cwd: project,
        report: { plan() {}, step() {} },
        edit: ({ manifest }) => {
          manifest.artifacts.push(parseRef("kit/kit/skill/lint"));
          return {};
        },
      }),
    ).rejects.toThrow(/ENOSPC/);
    return { project, before };
  }

  test("leaves the manifest as it was when apply fails before recording the lock", async ({
    tmp,
  }) => {
    failure.afterRecord = false;
    const { project, before } = await failedAdd(tmp);
    expect(await readFile(manifestPath(project), "utf8")).toBe(before);
  });

  test("keeps the manifest edit when the lock already records what it asked for", async ({
    tmp,
  }) => {
    failure.afterRecord = true;
    const { project } = await failedAdd(tmp);
    expect(await readFile(manifestPath(project), "utf8")).toContain("- kit/kit/skill/lint");
  });
});

describe("locate", () => {
  test("never makes the home folder a project from a .registry left there", async ({ tmp }) => {
    const home = join(tmp, "home");
    const elsewhere = join(home, "scope");
    vi.stubEnv("HOME", home);
    vi.stubEnv("AIREG_USER_SCOPE", elsewhere);
    await mkdir(join(home, ".registry"), { recursive: true });
    await writeFile(join(home, ".registry", "manifest.yml"), "artifacts: []\n");
    await mkdir(join(home, "notes"));
    expect(locate(undefined, join(home, "notes"))).toBeUndefined();
  });
});
