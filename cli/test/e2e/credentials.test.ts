import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { expectMode } from "#test/kit/mode.ts";
import { writeManifestIn } from "#test/kit/scope.ts";

const TOKEN = "synthetic-e2e-token";
const ORIGIN = "https://registry.acme.example";

/** A registry adapter that signs in, and notes in `seen` what each connect was given. */
const test = base.extend("signsIn", async ({ home: { dir: home, aireg } }) => {
  const adapter = join(home, "signs-in.mjs");
  const seen = join(home, "seen");
  const body = "---\nname: lint\n---\nrun\n";
  const digest = createHash("sha256").update(body).digest("hex");
  // Owner-only, as aireg makes it: under a 002 umask a plain mkdir is group-writable.
  await mkdir(aireg, { recursive: true, mode: 0o700 });
  await writeFile(
    adapter,
    `import { appendFile } from "node:fs/promises";
export default {
  id: "signs-in", displayName: "Signs in", protocol: 1, artifactKinds: ["skill"],
  dispatch: { hosts: ["registry.acme.example"] },
  capabilities: { pinsSource: false, auth: true },
  auth: {
    login: async ({ token }) => ({
      credential: { type: "bearer", accessToken: token },
      identity: { name: "jane@acme.example", account: "Acme\\u001b[31m Platform" },
    }),
  },
  connect: async (context) => {
    const given = context.credential?.accessToken === ${JSON.stringify(TOKEN)} ? "token" : "none";
    await appendFile(${JSON.stringify(seen)}, given + " " + context.source.location + "\\n");
    if (given === "none" && context.source.location.endsWith("/private")) {
      throw Object.assign(new Error("Sign in to read this registry."), {
        name: "AdapterError", adapter: "signs-in", failure: "unauthorized",
      });
    }
    return {
      resolve: async () => ({ artifacts: [{
        id: "skill_lint", kind: "skill",
        envelope: {
          apiVersion: "aireg.sh/v1", kind: "skill",
          metadata: { name: "lint", version: "1.0.0", description: "Lints." },
          files: [{ path: "SKILL.md", digest: "sha256:${digest}", size: ${Buffer.byteLength(body)},
            media_type: "text/markdown", urls: ["SKILL.md"] }],
        },
        files: [{ path: "SKILL.md", locator: "skill", executable: false }],
      }] }),
      fetch: async () => new TextEncoder().encode(${JSON.stringify(body)}),
      close: async () => {},
    };
  },
};
`,
  );
  await writeFile(
    join(aireg, "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  signs-in: ${adapter}\naccounts: []\njobs: []\n`,
  );
  return { seen: async () => readFile(seen, "utf8").catch(() => "") };
});

function project(location: string): string {
  return [
    "registries:",
    "  acme:",
    `    source: ${location}`,
    "    adapter: signs-in",
    "artifacts:",
    "  - acme/skill/lint",
    "",
  ].join("\n");
}

describe("credentials.json, end to end", () => {
  test("stores a piped token bound to its origin and never sends it to another host", async ({
    aireg,
    home,
    project: dir,
    signsIn,
  }) => {
    const login = await aireg(
      ["auth", "login", "acme", "--address", `${ORIGIN}/team`, "--token-stdin"],
      { input: `${TOKEN}\n` },
    );
    expect(login.code, login.stderr).toBe(0);
    expect(login.stdout).toContain(
      `Signed in to acme at ${ORIGIN}/team as jane@acme.example (Acme Platform).`,
    );

    const file = join(home.aireg, "credentials.json");
    await expectMode(file, 0o600);
    const stored = JSON.parse(await readFile(file, "utf8"));
    const [id] = Object.keys(stored.credentials);
    expect(stored).toEqual({
      version: 1,
      credentials: { [id as string]: { origin: ORIGIN, type: "bearer", access_token: TOKEN } },
    });
    expect(await readFile(join(home.aireg, "config.yml"), "utf8")).not.toContain("credential");
    const listed = (await aireg(["auth", "list", "--json"])).json<{
      accounts: { registry: string; signedIn: boolean }[];
    }>();
    expect(listed.data?.accounts).toMatchObject([{ registry: "acme", signedIn: true }]);

    // A cloned project that points the name at another host gets no token, and a reason.
    await writeManifestIn(dir, project("https://elsewhere.example/acme"));
    const refused = await aireg(["install", "--json"]);
    expect(refused.code).toBe(4);
    expect(refused.json().error).toMatchObject({
      code: "unauthorized",
      message: `Your sign-in for acme is for ${ORIGIN}, so aireg does not send it to https://elsewhere.example.`,
    });
    expect(refused.stdout + refused.stderr).not.toContain(TOKEN);
    expect(await signsIn.seen()).toBe("");

    // The same origin at another path is the registry the token was issued for.
    await writeManifestIn(dir, project(`${ORIGIN}/other-team`));
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(await signsIn.seen()).toContain(`token ${ORIGIN}/other-team`);

    const out = await aireg(["auth", "logout", "acme"]);
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, credentials: {} });
  });

  test("says how to sign in when a registry refuses a read without one", async ({
    aireg,
    project: dir,
    signsIn,
  }) => {
    await writeManifestIn(dir, project(`${ORIGIN}/private`));
    const refused = await aireg(["install", "--json"]);
    expect(refused.code).toBe(4);
    expect(refused.json().error).toMatchObject({
      code: "unauthorized",
      message: "Sign in to read this registry.",
      hint: "Run `aireg auth login acme`, or in CI set `AIREG_TOKEN_ACME`.",
    });
    expect(await signsIn.seen()).toBe(`none ${ORIGIN}/private\n`);
  });

  test("sends AIREG_TOKEN_<NAME> to the registry the project declares under that name", async ({
    aireg,
    home,
    project: dir,
    signsIn,
  }) => {
    const env = { AIREG_TOKEN_ACME: TOKEN };
    await writeManifestIn(dir, project(`${ORIGIN}/team`));
    const installed = await aireg(["install"], { env });
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout + installed.stderr).not.toContain(TOKEN);
    expect(await signsIn.seen()).toBe(`token ${ORIGIN}/team\n`);
    await expect(stat(join(home.aireg, "credentials.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refuses a dry run of one registry whose token another declared registry reads", async ({
    aireg,
    project: dir,
    signsIn,
  }) => {
    const shared = [
      "registries:",
      "  my--reg:",
      `    source: ${ORIGIN}/one`,
      "    adapter: signs-in",
      "  my__reg:",
      `    source: ${ORIGIN}/two`,
      "    adapter: signs-in",
      "artifacts:",
      "  - my--reg/skill/lint",
      "",
    ].join("\n");
    await writeManifestIn(dir, shared);

    const dry = await aireg(["sync", "--dry-run", "my--reg"], {
      env: { AIREG_TOKEN_MY__REG: TOKEN },
    });
    expect(dry.code).not.toBe(0);
    expect(dry.stderr).toContain("AIREG_TOKEN_MY__REG names both my--reg and my__reg");
    expect(await signsIn.seen()).toBe("");
  });

  test("declares an unreadable registry whose adapter supports sign-in and a credentials hint", async ({
    aireg,
    home,
    signsIn,
  }) => {
    const module = join(home.dir, "signs-in.mjs");
    const source = await readFile(module, "utf8");
    await writeFile(
      module,
      source.replace(
        "capabilities:",
        'credentialsHint: "Sign in with the Acme app.",\n  capabilities:',
      ),
    );
    const env = { AIREG_TOKEN_ACME: TOKEN };
    const added = await aireg(["registry", "add", `${ORIGIN}/private`, "--as", "acme", "-g"], {
      env,
    });
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain(`Added registry acme at ${ORIGIN}/private.`);
    expect(added.stdout).not.toContain("aireg auth login");
    expect(added.stdout + added.stderr).not.toContain(TOKEN);
    expect(await signsIn.seen()).toBe(`none ${ORIGIN}/private\n`);

    const shown = await aireg(["registry", "show", "acme", "-g"], { env });
    expect(shown.code, shown.stderr).toBe(0);
    expect(await signsIn.seen()).toBe(`none ${ORIGIN}/private\ntoken ${ORIGIN}/private\n`);
  }, 60_000);

  test("hands AIREG_TOKEN_<NAME> to the one sync the daemon runs for this command", async ({
    aireg,
    home,
    project: dir,
    signsIn,
  }) => {
    const env = { AIREG_TOKEN_ACME: TOKEN };
    await writeManifestIn(dir, project(`${ORIGIN}/team`));
    const synced = await aireg(["sync"], { env });
    expect(synced.code, synced.stderr).toBe(0);
    expect(synced.stdout + synced.stderr).not.toContain(TOKEN);
    expect(await signsIn.seen()).toMatch(/^(token .*\n)+$/);

    // The next run, without the variable, has no token: the daemon kept none.
    const before = (await signsIn.seen()).length;
    await aireg(["sync"]);
    expect((await signsIn.seen()).slice(before)).not.toContain("token");

    const logs = await aireg(["logs", "--tail", "500"]);
    expect(logs.stdout + logs.stderr).not.toContain(TOKEN);
    for (const entry of await readdir(home.aireg, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      expect(bytes.includes(TOKEN), entry.name).toBe(false);
    }
  });
});
