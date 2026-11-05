import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { withLease } from "#core/lease/lease.ts";
import { test } from "#test/kit/fixtures.ts";
import { expectMode } from "#test/kit/mode.ts";
import {
  CredentialStoreError,
  deleteCredential,
  readCredential,
  type StoredCredential,
  saveCredential,
  signedInAccounts,
} from "./store.ts";

const SECRET = "synthetic-secret-value";
const ORIGIN = "https://registry.acme.example";
const BEARER: StoredCredential = {
  origin: ORIGIN,
  credential: {
    type: "bearer",
    accessToken: SECRET,
    refreshToken: "synthetic-refresh",
    expiresAtMs: Date.UTC(2026, 9, 9, 18),
  },
};
const API_KEY: StoredCredential = {
  origin: "https://github.com",
  credential: { type: "apiKey", header: "Authorization", value: "synthetic-key" },
};

describe("credentials.json", () => {
  let root: string;
  let home: string;
  let file: string;
  let env: NodeJS.ProcessEnv;

  test.beforeEach(async ({ tmp }) => {
    root = tmp;
    home = join(root, ".aireg");
    file = join(home, "credentials.json");
    env = { AIREG_HOME: home };
  });

  test("reads a missing file as signed out and creates nothing", async () => {
    await expect(readCredential("acc_one", env)).resolves.toBeUndefined();
    await expect(signedInAccounts(env)).resolves.toEqual(new Set());
    await expect(deleteCredential("acc_one", env)).resolves.toBe(false);
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes one plain record per account, bound to its origin, owner-only", async () => {
    await saveCredential("acc_one", BEARER, env);
    await saveCredential("acc_two", API_KEY, env);
    await expectMode(home, 0o700);
    await expectMode(file, 0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      credentials: {
        acc_one: {
          origin: ORIGIN,
          type: "bearer",
          access_token: SECRET,
          refresh_token: "synthetic-refresh",
          expires_at: "2026-10-09T18:00:00Z",
        },
        acc_two: {
          origin: "https://github.com",
          type: "api_key",
          header: "Authorization",
          value: "synthetic-key",
        },
      },
    });
    await expect(readCredential("acc_one", env)).resolves.toEqual(BEARER);
    await expect(readCredential("acc_two", env)).resolves.toEqual(API_KEY);
    await expect(signedInAccounts(env)).resolves.toEqual(new Set(["acc_one", "acc_two"]));
  });

  test("reads an expiry written with an offset or fractional seconds", async () => {
    await saveCredential("acc_one", BEARER, env);
    const document = JSON.parse(await readFile(file, "utf8"));
    document.credentials.acc_one.expires_at = "2026-10-09T20:00:00.250+02:00";
    await writeFile(file, JSON.stringify(document), { mode: 0o600 });
    const read = await readCredential("acc_one", env);
    expect(read?.credential).toMatchObject({ expiresAtMs: Date.UTC(2026, 9, 9, 18, 0, 0, 250) });
  });

  test("refuses to store a credential for something that is not an origin", async () => {
    for (const origin of ["https://registry.acme.example/path", "HTTPS://Acme.Example", "/srv"]) {
      await expect(saveCredential("acc_one", { ...BEARER, origin }, env)).rejects.toThrow(
        "is not an origin",
      );
    }
  });

  test.skipIf(process.platform === "win32")(
    "refuses a file other users can read, and says how to fix it",
    async () => {
      await saveCredential("acc_one", BEARER, env);
      await chmod(file, 0o644);
      await expect(readCredential("acc_one", env)).rejects.toMatchObject({
        hint: `Run \`chmod 600 ${file}\`, then sign in again.`,
      });
      await expect(saveCredential("acc_two", API_KEY, env)).rejects.toBeInstanceOf(
        CredentialStoreError,
      );
      await expectMode(file, 0o644);
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a symbolic link in place of the file",
    async () => {
      await saveCredential("acc_one", BEARER, env);
      const elsewhere = join(root, "elsewhere.json");
      await writeFile(elsewhere, await readFile(file, "utf8"), { mode: 0o600 });
      await rm(file);
      await symlink(elsewhere, file);
      await expect(readCredential("acc_one", env)).rejects.toThrow("is a symbolic link");
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a home other users can write to, since they could swap the file",
    async () => {
      await saveCredential("acc_one", BEARER, env);
      await chmod(home, 0o777);
      await expect(readCredential("acc_one", env)).rejects.toMatchObject({
        hint: `Run \`chmod 700 ${home}\`.`,
      });
    },
  );

  // A plain recursive mkdir under umask 002 makes 0775, which the read below refuses.
  test.skipIf(process.platform === "win32")(
    "keeps the home owner-only when a lease creates it first under umask 002",
    async () => {
      const previous = process.umask(0o002);
      try {
        const roots = { scope: "user" as const, lock: join(root, "manifest.lock.yml") };
        await withLease(roots, { env }, async () => {});
        await expectMode(home, 0o700);
        await saveCredential("acc_one", BEARER, env);
        await expect(readCredential("acc_one", env)).resolves.toEqual(BEARER);
      } finally {
        process.umask(previous);
      }
    },
  );

  test("replaces the file whole and leaves nothing beside it but the leases", async () => {
    await saveCredential("acc_one", BEARER, env);
    const before = (await stat(file)).ino;
    await saveCredential("acc_one", API_KEY, env);
    expect((await stat(file)).ino).not.toBe(before);
    expect((await readdir(home)).filter((name) => name !== "leases")).toEqual(["credentials.json"]);
    await expect(readCredential("acc_one", env)).resolves.toEqual(API_KEY);
  });

  test("serializes writers so no update is lost", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `acc_${index}`);
    await Promise.all(ids.map((id) => saveCredential(id, BEARER, env)));
    await expect(signedInAccounts(env)).resolves.toEqual(new Set(ids));
  });

  test("deletes one entry and keeps the rest", async () => {
    await saveCredential("acc_one", BEARER, env);
    await saveCredential("acc_two", API_KEY, env);
    await expect(deleteCredential("acc_one", env)).resolves.toBe(true);
    await expect(deleteCredential("acc_one", env)).resolves.toBe(false);
    await expect(readCredential("acc_one", env)).resolves.toBeUndefined();
    await expect(readCredential("acc_two", env)).resolves.toEqual(API_KEY);
    await expectMode(file, 0o600);
  });

  test("refuses a malformed file without quoting it, and never overwrites it", async () => {
    await saveCredential("acc_one", BEARER, env);
    const good = JSON.parse(await readFile(file, "utf8")).credentials.acc_one;
    const broken = `{"version": 1, "credentials": {"acc_one": ${SECRET}}`;
    const shapes = [
      broken,
      "[]",
      JSON.stringify({ version: 2, credentials: {} }),
      JSON.stringify({ version: 1, credentials: [] }),
      JSON.stringify({ version: 1, credentials: {}, token: SECRET }),
      JSON.stringify({ version: 1, credentials: { [SECRET]: good } }),
      JSON.stringify({ version: 1, credentials: { acc_one: SECRET } }),
      JSON.stringify({ version: 1, credentials: { acc_one: { ...good, origin: undefined } } }),
      JSON.stringify({ version: 1, credentials: { acc_one: { ...good, origin: SECRET } } }),
      JSON.stringify({ version: 1, credentials: { acc_one: { ...good, type: SECRET } } }),
      JSON.stringify({ version: 1, credentials: { acc_one: { ...good, access_token: 1 } } }),
      JSON.stringify({ version: 1, credentials: { acc_one: { ...good, expires_at: SECRET } } }),
      JSON.stringify({ version: 1, credentials: { acc_one: { ...good, [SECRET]: 1 } } }),
    ];
    for (const text of shapes) {
      await writeFile(file, text);
      const failed = await readCredential("acc_one", env).catch((error: unknown) => error);
      expect(failed, text).toBeInstanceOf(CredentialStoreError);
      const error = failed as CredentialStoreError;
      expect(error.message).toContain("is not a valid credentials file");
      expect(error.message).not.toContain(SECRET);
      expect(error.cause).toBeUndefined();
    }
    await writeFile(file, broken);
    await expect(saveCredential("acc_two", API_KEY, env)).rejects.toThrow(CredentialStoreError);
    await expect(deleteCredential("acc_one", env)).rejects.toThrow(CredentialStoreError);
    expect(await readFile(file, "utf8")).toBe(broken);
  });

  test("names the field that is wrong, never its value", async () => {
    await saveCredential("acc_one", BEARER, env);
    const document = JSON.parse(await readFile(file, "utf8"));
    document.credentials.acc_one.expires_at = "tomorrow";
    await writeFile(file, JSON.stringify(document));
    await expect(readCredential("acc_one", env)).rejects.toThrow(
      `${file} is not a valid credentials file: the entry for acc_one: its expires_at is not an RFC 3339 time.`,
    );
  });

  test("refuses keys that are not account ids", async () => {
    for (const accountId of ["credentials/acc_one", "one", "acc_", "acc_one/../acc_two"]) {
      await expect(saveCredential(accountId, BEARER, env)).rejects.toThrow("is not an account id");
      await expect(readCredential(accountId, env)).rejects.toThrow("is not an account id");
      await expect(deleteCredential(accountId, env)).rejects.toThrow("is not an account id");
    }
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("credentials.json across processes", () => {
  test("keeps every entry when two processes write at once", async ({ tmp }) => {
    const home = join(tmp, ".aireg");
    const module = new URL("./store.ts", import.meta.url).pathname;
    const writer = (prefix: string) =>
      `const { saveCredential } = await import(${JSON.stringify(module)});
       const env = { AIREG_HOME: ${JSON.stringify(home)} };
       const stored = { origin: ${JSON.stringify(ORIGIN)}, credential: { type: "bearer", accessToken: "v" } };
       for (let i = 0; i < 25; i += 1) await saveCredential("acc_${prefix}" + i, stored, env);`;
    const { spawn } = await import("node:child_process");
    const run = (script: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", script],
          { stdio: "ignore" },
        );
        child.once("exit", (code) => resolve(code ?? 1));
      });
    expect(await Promise.all([run(writer("a")), run(writer("b"))])).toEqual([0, 0]);
    const ids = ["a", "b"].flatMap((prefix) =>
      Array.from({ length: 25 }, (_, index) => `acc_${prefix}${index}`),
    );
    await expect(signedInAccounts({ AIREG_HOME: home })).resolves.toEqual(new Set(ids));
  });

  test("waits while another writer holds the file's lease", async ({ tmp }) => {
    const home = join(tmp, ".aireg");
    const env = { AIREG_HOME: home };
    await mkdir(home, { recursive: true, mode: 0o700 });
    const roots = { scope: "user" as const, lock: join(home, "credentials.json") };
    let release: (() => void) | undefined;
    const holding = withLease(roots, { env }, () => new Promise<void>((done) => (release = done)));
    await vi.waitFor(() => expect(release).toBeDefined());

    let saved = false;
    const saving = saveCredential("acc_one", BEARER, env).then(() => {
      saved = true;
    });
    await new Promise((wake) => setTimeout(wake, 300));
    expect(saved).toBe(false);
    release?.();
    await Promise.all([holding, saving]);
    await expect(readCredential("acc_one", env)).resolves.toEqual(BEARER);
  });
});
