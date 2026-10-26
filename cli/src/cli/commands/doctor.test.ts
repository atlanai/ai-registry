import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { Printer } from "#core/output.ts";
import type { TrustedKeys } from "#core/release/keyring.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";
import { resolveTargets } from "#core/target/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { run } from "./doctor.ts";
import type { CommandContext } from "./index.ts";

// The stamp is build-time only, so a test substitutes one rather than reading env.
const stub = vi.hoisted(() => ({ stamp: undefined as ReleaseStamp | undefined }));

vi.mock("#core/release/stamp.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#core/release/stamp.ts")>();
  return {
    ...actual,
    releaseStamp: (env?: NodeJS.ProcessEnv) => stub.stamp ?? actual.releaseStamp(env),
  };
});

registerBuiltinAdapters();

async function checks(cwd: string): Promise<Map<string, { ok: boolean; detail: string }>> {
  const writes: string[] = [];
  await run(context(cwd, writes));
  const payload = JSON.parse(writes.join("")) as {
    data: { checks: { name: string; ok: boolean; detail: string }[] };
  };
  return new Map(payload.data.checks.map((check) => [check.name, check]));
}

function context(cwd: string, writes: string[]): CommandContext {
  return {
    argv: [],
    cwd,
    printer: new Printer({
      format: "json",
      out: { write: (chunk: string) => writes.push(chunk), isTTY: false },
    }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}

describe("doctor", () => {
  let cwd: string;

  test.beforeEach(async ({ tmp }) => {
    cwd = tmp;
    vi.stubEnv("AIREG_HOME", join(cwd, "home"));
    vi.stubEnv("AIREG_USER_SCOPE", join(cwd, "registry"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stub.stamp = undefined;
  });

  test("checks the machine, and lists no targets", async () => {
    const writes: string[] = [];
    await run(context(cwd, writes));
    const payload = JSON.parse(writes.join("")) as { data: { checks: { name: string }[] } };
    const names = payload.data.checks.map((check) => check.name);
    expect(names).toContain("symlinks");
    // `aireg targets` is the one place tools are listed.
    for (const target of Object.keys(resolveTargets())) expect(names).not.toContain(target);
  });

  // Windows keeps no POSIX permission bits for the owner-only check to read.
  test.skipIf(process.platform === "win32")(
    "checks that credentials.json is owner-only without reading it",
    async () => {
      const row = async () => {
        const writes: string[] = [];
        await run(context(cwd, writes));
        const payload = JSON.parse(writes.join("")) as {
          data: { checks: { name: string; ok: boolean; detail: string }[] };
        };
        return payload.data.checks.find((check) => check.name === "credentials");
      };
      expect(await row()).toMatchObject({ ok: true, detail: "none stored" });

      const file = join(cwd, "home", "credentials.json");
      await mkdir(join(cwd, "home"), { recursive: true });
      await writeFile(file, "not read");
      await chmod(file, 0o600);
      expect(await row()).toMatchObject({
        ok: true,
        detail: expect.stringContaining("owner only"),
      });
      await chmod(file, 0o644);
      expect(await row()).toMatchObject({ ok: false, fix: expect.stringContaining("chmod 600") });
    },
  );

  test.skipIf(process.platform === "win32")(
    "flags a credentials file every command would refuse",
    async () => {
      const home = join(cwd, "home");
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(cwd, "elsewhere.json"), "not read", { mode: 0o600 });
      await symlink(join(cwd, "elsewhere.json"), join(home, "credentials.json"));
      expect((await checks(cwd)).get("credentials")).toMatchObject({
        ok: false,
        detail: expect.stringContaining("is a symbolic link"),
      });
    },
  );

  test("reports an adapter that does not load instead of failing", async () => {
    const home = join(cwd, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "config.yml"),
      `schemaVersion: 1\nrevision: 0\nadapters:\n  broken: ${join(cwd, "missing.mjs")}\naccounts: []\njobs: []\n`,
    );
    expect((await checks(cwd)).get("adapter broken")).toMatchObject({ ok: false });
  });

  test.skipIf(process.platform === "win32")(
    "flags a home other users can write to, with the fix",
    async () => {
      expect((await checks(cwd)).get("home")).toMatchObject({
        ok: true,
        detail: expect.stringContaining("not created yet"),
      });
      const home = join(cwd, "home");
      await mkdir(home, { mode: 0o700 });
      expect((await checks(cwd)).get("home")).toMatchObject({ ok: true });
      await chmod(home, 0o775);
      expect((await checks(cwd)).get("home")).toMatchObject({
        ok: false,
        fix: expect.stringContaining("chmod 700"),
      });
    },
  );

  test("says a build that does not update itself has no updates to check", async () => {
    expect((await checks(cwd)).get("updates")).toMatchObject({
      ok: true,
      info: true,
      detail: "not in this build, so update aireg the way you installed it",
    });
  });

  test("shows the stamped channel and the last check", async () => {
    stub.stamp = {
      origin: "https://releases.example.com/aireg/cli",
      channel: "stable",
      keys: new Map() as TrustedKeys,
    };
    expect((await checks(cwd)).get("updates")).toMatchObject({
      detail: "stable channel, not checked yet",
      fix: "aireg self update --check",
    });

    await mkdir(join(cwd, "home", "state"), { recursive: true });
    await writeFile(
      join(cwd, "home", "state", "update-check.json"),
      '{"checkedAt":1,"latest":"9.9.9"}',
    );
    expect((await checks(cwd)).get("updates")).toMatchObject({
      ok: true,
      detail: "stable channel, 9.9.9 is available",
      fix: "aireg self update",
    });
  });
});
