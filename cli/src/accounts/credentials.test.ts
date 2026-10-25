import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { type Account, emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { saveCredential } from "#core/credentials/store.ts";
import { ADAPTER } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";
import { credentialFor, credentialForLocation, credentialsForManifest } from "./credentials.ts";

const SIGNED_IN = "http://dev.registry.localhost/one";
const SAME_ORIGIN = "http://dev.registry.localhost/two";
const ELSEWHERE = "http://other.registry.localhost/steal";
const SIGNS_IN = { adapter: "dev" };
const RECOGNISED = { adapter: undefined };
const STORED = "synthetic-stored-token";
const FROM_ENV = "synthetic-env-token";

async function declareForUser(home: string, registries: Record<string, string>): Promise<void> {
  const lines = Object.entries(registries).flatMap(([alias, source]) => [
    `  ${alias}:`,
    `    source: ${source}`,
    "    adapter: dev",
  ]);
  await writeFile(join(home, "manifest.yml"), ["registries:", ...lines, ""].join("\n"));
}

async function signIn(account: Account, origin = "http://dev.registry.localhost"): Promise<void> {
  await saveCredential(account.id, {
    origin,
    credential: { type: "bearer", accessToken: STORED },
  });
  await writeConfig(
    { ...emptyRegistryConfig(), adapters: { dev: ADAPTER }, accounts: [account] },
    0,
  );
}

/** What a hostile project's `.registry/manifest.yml` would declare. */
function project(location: string) {
  return { acme: { location, adapter: "dev", config: {} } };
}

describe("credentials", () => {
  let home: string;

  beforeAll(() => registerBuiltinAdapters());
  test.beforeEach(async ({ tmp }) => {
    home = tmp;
    vi.stubEnv("AIREG_HOME", home);
    vi.stubEnv("AIREG_USER_SCOPE", home);
  });
  afterEach(() => vi.unstubAllEnvs());

  test("sends a stored token to the origin it was issued for, at any path", async () => {
    await declareForUser(home, { acme: SIGNED_IN });
    await signIn({ id: "acc_one", registry: "acme" });

    expect(await credentialFor("acme", SIGNS_IN, SIGNED_IN, ["acme"])).toEqual({
      type: "bearer",
      accessToken: STORED,
    });
    expect(await credentialsForManifest(project(SAME_ORIGIN), home)).toEqual({
      acme: { type: "bearer", accessToken: STORED },
    });
  });

  test("never sends a stored token to a host a project manifest names, and says why", async () => {
    await declareForUser(home, { acme: SIGNED_IN });
    await signIn({ id: "acc_one", registry: "acme" });

    const refused = await credentialsForManifest(project(ELSEWHERE), home).catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      code: "unauthorized",
      message:
        "Your sign-in for acme is for http://dev.registry.localhost, so aireg does not send it to http://other.registry.localhost.",
      hint: expect.stringContaining("declare it under another name"),
    });
    expect(String((refused as Error).message)).not.toContain(STORED);
  });

  test("never sends a stored token to a scheme or port it was not issued for", async () => {
    await declareForUser(home, { acme: SIGNED_IN });
    await signIn({ id: "acc_one", registry: "acme" });

    for (const location of [
      "https://dev.registry.localhost/one",
      "http://dev.registry.localhost:8080/one",
    ]) {
      await expect(credentialsForManifest(project(location), home)).rejects.toMatchObject({
        code: "unauthorized",
      });
    }
  });

  test("gives git and folder registries no token: git brings its own credentials", async () => {
    vi.stubEnv("AIREG_TOKEN_ACME", FROM_ENV);

    expect(
      await credentialFor("acme", RECOGNISED, "https://github.com/acme/ai-registry", ["acme"]),
    ).toBeUndefined();
    expect(
      await credentialFor("acme", RECOGNISED, join(home, "registry"), ["acme"]),
    ).toBeUndefined();
  });

  test("sends AIREG_TOKEN_<NAME> to the registry the current scope declares", async () => {
    vi.stubEnv("AIREG_TOKEN_ACME", FROM_ENV);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    // Only the project declares acme, as on CI.
    const token = { type: "bearer", accessToken: FROM_ENV };
    expect(await credentialsForManifest(project(ELSEWHERE), home)).toEqual({ acme: token });
    expect(await credentialFor("acme", SIGNS_IN, ELSEWHERE, ["acme"])).toEqual(token);
  });

  test("never sends AIREG_TOKEN_<NAME> to an address nothing declares under that name", async () => {
    vi.stubEnv("AIREG_TOKEN_ACME", FROM_ENV);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);
    await declareForUser(home, { acme: SIGNED_IN });

    const refused = await credentialForLocation(ELSEWHERE, "acme", SIGNS_IN).catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      code: "unauthorized",
      message:
        "AIREG_TOKEN_ACME is set, but http://other.registry.localhost/steal is not declared as acme, so aireg does not send it there.",
      hint: "To send it there, declare it: `aireg registry add http://other.registry.localhost/steal --as acme`.",
    });
    expect(String((refused as Error).message)).not.toContain(FROM_ENV);
  });

  test("prefers AIREG_TOKEN_<NAME> to a stored sign-in", async () => {
    vi.stubEnv("AIREG_TOKEN_ACME", FROM_ENV);
    await declareForUser(home, { acme: SIGNED_IN });
    await signIn({ id: "acc_one", registry: "acme" });

    const token = { type: "bearer", accessToken: FROM_ENV };
    expect(await credentialFor("acme", SIGNS_IN, SIGNED_IN, ["acme"])).toEqual(token);
    // A project that moves acme gets the token it was given, never the stored one.
    expect(await credentialsForManifest(project(ELSEWHERE), home)).toEqual({ acme: token });
  });

  // `my--reg` and `my__reg` get separate folders but share one token variable.
  test("refuses an environment token two declared aliases share", async () => {
    vi.stubEnv("AIREG_TOKEN_MY__REG", FROM_ENV);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);
    await declareForUser(home, { "my--reg": SIGNED_IN, my__reg: SAME_ORIGIN });

    await expect(credentialFor("my__reg", SIGNS_IN, SAME_ORIGIN, ["my__reg"])).rejects.toThrow(
      "AIREG_TOKEN_MY__REG names both my__reg and my--reg",
    );
  });

  test("refuses an environment token two aliases only the project declares share", async () => {
    vi.stubEnv("AIREG_TOKEN_MY__REG", FROM_ENV);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    // The user scope declares neither, so only the project's names can show the clash.
    await expect(
      credentialFor("my__reg", SIGNS_IN, SAME_ORIGIN, ["my--reg", "my__reg"]),
    ).rejects.toThrow("AIREG_TOKEN_MY__REG names both my__reg and my--reg");
  });

  // Windows keeps no permission bits to refuse a readable file by.
  test.skipIf(process.platform === "win32")(
    "reads credentials.json only for a registry that could use a stored sign-in",
    async () => {
      await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);
      const file = join(home, "credentials.json");
      await writeFile(file, "{");
      await chmod(file, 0o644);
      const folder = join(home, "registry");
      await mkdir(folder);

      // A folder registry, and one that signs in but has no account, never open the file.
      expect(
        await credentialsForManifest(
          { kit: { location: folder, adapter: undefined, config: {} } },
          home,
        ),
      ).toEqual({});
      expect(await credentialsForManifest(project(SIGNED_IN), home)).toEqual({});

      // One with an account still refuses a file other users can read.
      await writeConfig(
        {
          ...emptyRegistryConfig(),
          revision: 1,
          adapters: { dev: ADAPTER },
          accounts: [{ id: "acc_one", registry: "acme" }],
        },
        1,
      );
      await expect(credentialsForManifest(project(SIGNED_IN), home)).rejects.toThrow(
        "can be read by other users",
      );
    },
  );

  test("probes an undeclared address without a sign-in issued for another origin", async () => {
    await declareForUser(home, { acme: SIGNED_IN });
    await signIn({ id: "acc_one", registry: "acme" });

    expect(await credentialForLocation(ELSEWHERE, "acme", SIGNS_IN)).toBeUndefined();
    expect(await credentialForLocation(SIGNED_IN, "acme", SIGNS_IN)).toEqual({
      type: "bearer",
      accessToken: STORED,
    });
  });
});
