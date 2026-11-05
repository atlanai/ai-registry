import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

// Root reads any folder, and Windows has no mode bits to take away.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports status past a folder beside the skills it may not read",
  async ({ aireg, project }) => {
    await mkdir(join(project, ".registry"), { recursive: true });
    await writeFile(
      join(project, ".registry", "manifest.yml"),
      `registries:\n  acme: ${ACME}\nartifacts:\n  - acme/engineering/skill/pr-review\n`,
    );
    expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
    const locked = join(project, ".claude", "skills", "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const status = await aireg(["status", "--json"]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.json().ok).toBe(true);
    } finally {
      await chmod(locked, 0o700);
    }
  },
);
