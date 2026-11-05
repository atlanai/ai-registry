import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import type { Credential } from "#adapter/index.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { readCredential, saveCredential } from "#core/credentials/store.ts";
import { test } from "#test/kit/fixtures.ts";
import { accountCredential, signIn } from "./service.ts";

const ENDPOINT = "https://registry.acme.example";

/** Refreshes slowly and counts each refresh token it spends, as a rotating server would. */
async function rotating(home: string): Promise<string> {
  const module = join(home, "rotating.mjs");
  const spent = join(home, "spent");
  const revoked = join(home, "revoked");
  await writeFile(
    module,
    `import { appendFile } from "node:fs/promises";
export default {
  id: "rotating", displayName: "Rotating", protocol: 1, artifactKinds: ["skill"],
  dispatch: { hosts: ["registry.acme.example"] },
  capabilities: { pinsSource: false, auth: true },
  auth: {
    login: async ({ oauth }) => ({ credential: oauth ?? { type: "bearer", accessToken: "unused" } }),
    revoke: async (endpoint, credential) => {
      await appendFile(${JSON.stringify(revoked)}, credential.refreshToken + "\\n");
    },
    refresh: async (endpoint, credential) => {
      await appendFile(${JSON.stringify(spent)}, credential.refreshToken + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const next = Number(credential.refreshToken.slice(1)) + 1;
      return { type: "bearer", accessToken: "a" + next, refreshToken: "r" + next, expiresAtMs: Date.now() + 900_000 };
    },
  },
  connect: async () => ({ resolve: async () => ({ artifacts: [] }), fetch: async () => new Uint8Array(), close: async () => {} }),
};
`,
  );
  return module;
}

const signal = new AbortController().signal;

/** A home declaring `acme` on the rotating adapter, its account signed in with `stored`. */
async function signedIn(
  tmp: string,
  stored: Credential,
): Promise<{ id: string; registry: string }> {
  vi.stubEnv("AIREG_HOME", tmp);
  vi.stubEnv("AIREG_USER_SCOPE", tmp);
  const account = { id: "acc_one", registry: "acme" };
  await writeFile(
    join(tmp, "manifest.yml"),
    `registries:\n  acme:\n    source: ${ENDPOINT}\n    adapter: rotating\n`,
  );
  await writeConfig(
    { ...emptyRegistryConfig(), adapters: { rotating: await rotating(tmp) }, accounts: [account] },
    0,
  );
  await saveCredential(account.id, { origin: ENDPOINT, credential: stored });
  return account;
}

async function revoked(tmp: string): Promise<string[]> {
  const text = await readFile(join(tmp, "revoked"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

describe("account sign-in", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("ends a session a new sign-in replaces, never an operator's token", async ({ tmp }) => {
    await signedIn(tmp, { type: "bearer", accessToken: "operator-1" });
    const login = (refreshToken: string) =>
      signIn(
        { registry: "acme" },
        { oauth: { type: "bearer", accessToken: `a-${refreshToken}`, refreshToken } },
        signal,
      );
    await login("r1");
    expect(await revoked(tmp)).toEqual([]);
    await login("r2");
    expect(await revoked(tmp)).toEqual(["r1"]);
  });

  test("ends a sign-in whose account could not be saved, rather than keep it", async ({ tmp }) => {
    await signedIn(tmp, { type: "bearer", accessToken: "unused" });
    await writeConfig({ ...emptyRegistryConfig(), adapters: { rotating: await rotating(tmp) } }, 1);
    const login = (refreshToken: string) =>
      signIn(
        { registry: "acme" },
        { oauth: { type: "bearer", accessToken: `a-${refreshToken}`, refreshToken } },
        signal,
      );
    const [first, second] = await Promise.allSettled([login("r1"), login("r2")]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(await revoked(tmp)).toEqual([first.status === "rejected" ? "r1" : "r2"]);
    const stored = JSON.parse(await readFile(join(tmp, "credentials.json"), "utf8"));
    expect(Object.keys(stored.credentials)).toHaveLength(2);
  });

  test("spends a refresh token once when two callers refresh at the same time", async ({ tmp }) => {
    const account = await signedIn(tmp, {
      type: "bearer",
      accessToken: "a1",
      refreshToken: "r1",
      expiresAtMs: 0,
    });

    const both = await Promise.all([
      accountCredential(account, ENDPOINT, signal),
      accountCredential(account, ENDPOINT, signal),
    ]);

    expect(
      both.map((credential) => credential.type === "bearer" && credential.accessToken),
    ).toEqual(["a2", "a2"]);
    expect(await readFile(join(tmp, "spent"), "utf8")).toBe("r1\n");
    expect((await readCredential(account.id))?.credential).toMatchObject({ refreshToken: "r2" });
  });
});
