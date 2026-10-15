import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ADAPTER, ENDPOINT, NAMESPACE, testClient } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";
import { expectMode } from "#test/kit/mode.ts";

/** So `account.login` can resolve the alias against the user's own manifest. */
async function declareUserRegistry(scope: string): Promise<void> {
  await mkdir(scope, { recursive: true });
  await writeFile(
    join(scope, "manifest.yml"),
    ["registries:", "  personal:", `    source: ${ENDPOINT}`, "    adapter: dev", ""].join("\n"),
  );
}

describe("account.login", () => {
  test("declares the registry when the caller names its address", async ({ tmp, home, daemon }) => {
    // Signing in is the one route into manifest.yml that creates no job as a side effect.
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("declare_test"));
    const logged = await client.request("account.login", {
      registry: "acme",
      address: ENDPOINT,
      adapter: "dev",
    });
    expect(logged.account.registry).toBe("acme");
    expect(await readFile(join(home.scope, "manifest.yml"), "utf8")).toContain("acme:");

    // Declaring is once; a re-login keeps the id it already minted.
    const again = await client.request("account.login", { registry: "acme" });
    expect(again.account.id).toBe(logged.account.id);
    expect(again.created).toBe(false);
  });

  test("refuses an address other than the one the user scope declares, sending nothing", async ({
    tmp,
    home,
    daemon,
  }) => {
    await declareUserRegistry(home.scope);
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("moved_test"));
    const failed = await client
      .request("account.login", {
        registry: "personal",
        address: "http://other.registry.localhost/team",
        adapter: "dev",
      })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({
      message: `personal is ${ENDPOINT} in your user scope, not http://other.registry.localhost/team.`,
      data: { code: "usage" },
    });
    await expect(stat(join(home.aireg, "credentials.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Naming the address it already has is the same sign-in as naming none.
    const same = await client.request("account.login", {
      registry: "personal",
      address: ENDPOINT,
      adapter: "dev",
    });
    expect(same.account.registry).toBe("personal");
  });

  test("says which registries are declared when the alias names none of them", async ({
    home,
    daemon,
  }) => {
    await declareUserRegistry(home.scope);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("unknown_test"));
    const failed = await client
      .request("account.login", { registry: "nowhere" })
      .catch((error: unknown) => error);
    // Named, not "internal error": the caller can act on this one.
    expect(failed).toMatchObject({ code: RpcErrorCode.NotFound });
    expect((failed as Error).message).toBe('No registry named "nowhere" in your user scope.');
  });

  test("names a registry with no sign-in rather than failing internally", async ({
    tmp,
    home,
    daemon,
  }) => {
    await mkdir(join(tmp, "registry"));
    await mkdir(home.scope, { recursive: true });
    await writeFile(
      join(home.scope, "manifest.yml"),
      `registries:\n  acme: ${join(tmp, "registry")}\n`,
    );
    registerBuiltinAdapters();

    const { client } = await daemon.start(testClient("login_none_test"));
    const failed = await client
      .request("account.login", { registry: "acme" })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: RpcErrorCode.Server });
    expect((failed as Error).message).toContain("acme needs no sign-in");
  });

  test("binds a named registry and puts no credential on the socket", async ({
    tmp,
    home,
    daemon,
  }) => {
    await declareUserRegistry(home.scope);
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("login_test"));
    const logged = await client.request("account.login", { registry: "personal" });
    expect(logged.account.registry).toBe("personal");
    expect(logged.created).toBe(true);
    expect(logged.account).not.toHaveProperty("credential");
    const snap = await client.request("state.snapshot", {});
    expect(snap.config.accounts[0]).not.toHaveProperty("credential");

    // Upserts by registry: a re-login keeps the same id so every job
    // that named it keeps working.
    const again = await client.request("account.login", { registry: "personal" });
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(logged.account.id);
    expect((await client.request("state.snapshot", {})).config.accounts).toHaveLength(1);
  });
});

describe("account.logout", () => {
  test("keeps the token owner-only in credentials.json, bound to its origin, and deletes it", async ({
    tmp,
    home,
    daemon,
  }) => {
    const file = join(home.aireg, "credentials.json");
    await declareUserRegistry(home.scope);
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("logout_file_test"));
    const logged = await client.request("account.login", { registry: "personal" });
    const id = logged.account.id;
    await expectMode(file, 0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      credentials: {
        [id]: {
          origin: ENDPOINT,
          type: "api_key",
          header: "x-dev-key",
          value: "development",
        },
      },
    });
    // Signed in is an entry in credentials.json; config.yml holds no pointer to it.
    const config = await readFile(join(home.aireg, "config.yml"), "utf8");
    expect(config).toContain(id);
    expect(config).not.toContain("credential");

    await client.request("account.logout", { accountId: id });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, credentials: {} });
    expect((await client.request("state.snapshot", {})).config.accounts).toEqual([
      { id, registry: "personal" },
    ]);
  });

  test("deletes a stored token once nothing declares its registry", async ({
    tmp,
    home,
    daemon,
  }) => {
    await declareUserRegistry(home.scope);
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("logout_undeclared_test"));
    const logged = await client.request("account.login", { registry: "personal" });
    await writeFile(join(home.scope, "manifest.yml"), "registries: {}\n");

    await client.request("account.logout", { accountId: logged.account.id });
    expect(JSON.parse(await readFile(join(home.aireg, "credentials.json"), "utf8"))).toEqual({
      version: 1,
      credentials: {},
    });
  });

  test("names a missing account", async ({ daemon }) => {
    await writeConfig(emptyRegistryConfig(), 0);

    const { client } = await daemon.start(testClient("logout_test"));
    const missing = await client
      .request("account.logout", { accountId: "acc_missing" })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'No account named "acc_missing".',
    });
  });
});

describe("account.remove", () => {
  test("names a missing account and refuses one a job still uses", async ({
    tmp,
    home,
    project,
    daemon,
  }) => {
    await declareUserRegistry(home.scope);
    vi.stubEnv("AIREG_DEV_REMOTE", join(tmp, "remote"));
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("remove_test"));
    const missing = await client
      .request("account.remove", { accountId: "acc_missing" })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'No account named "acc_missing".',
    });

    const logged = await client.request("account.login", { registry: "personal" });
    const before = await client.request("state.snapshot", {});
    await client.request("job.create", {
      expectedRevision: before.config.revision,
      root: project,
      scope: "project",
      registry: "personal",
      address: ENDPOINT,
      adapter: "dev",
      config: { namespace: NAMESPACE },
      name: "watch_demo",
      intervalSeconds: 3600,
      policy: { pull: "report", publish: "off", delete: "off" },
    });
    const blocked = await client
      .request("account.remove", { accountId: logged.account.id })
      .catch((error: unknown) => error);
    expect(blocked).toMatchObject({
      code: RpcErrorCode.Server,
      message: "The account is used by 1 job: watch_demo.",
      data: { code: "conflict", hint: "Remove it first with `aireg job remove watch_demo`." },
    });
  });
});
