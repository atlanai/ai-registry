import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { writeInstallRecord } from "#core/adapter/installed/record.ts";
import { adapterFor, limitsFor, loadAdapter } from "#core/adapter/load.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { registerBuiltinAdapters } from "./index.ts";

function configYaml(id: string, modulePath: string): string {
  return [
    "schemaVersion: 1",
    "revision: 0",
    "adapters:",
    // JSON is YAML, and quotes a Windows path's backslashes.
    `  ${id}: ${JSON.stringify(modulePath)}`,
    "accounts: []",
    "jobs: []",
    "",
  ].join("\n");
}

function adapterModule(id: string, displayName: string, extra = ""): string {
  return [
    extra,
    "export default {",
    `  id: ${JSON.stringify(id)},`,
    `  displayName: ${JSON.stringify(displayName)},`,
    "  protocol: 1,",
    '  artifactKinds: ["skill"],',
    '  dispatch: { hosts: ["configured.example"] },',
    "  capabilities: { pinsSource: false },",
    "  connect: async () => ({",
    "    resolve: async () => ({ artifacts: [] }),",
    "    fetch: async () => new Uint8Array(),",
    "    close: async () => {},",
    "  }),",
    "};",
    "",
  ].join("\n");
}

describe("CLI adapter composition", () => {
  // Dispatch reads the config for adapter overrides, so without a home of its
  // own this asserts against whatever the person running it has installed.
  test("dispatches on declared hosts, and falls back to git", async () => {
    registerBuiltinAdapters();

    expect((await adapterFor("acme/kit", undefined)).id).toBe("git");
    expect((await adapterFor("git@github.com:acme/kit.git", undefined)).id).toBe("git");
    expect((await adapterFor("/tmp/kit", undefined)).id).toBe("local");
  });

  test("reads a site's web address as its skills index, and a code host's as git", async () => {
    registerBuiltinAdapters();

    for (const site of [
      "https://gateway.example.com",
      "https://docs.example.com/guide/",
      "http://localhost:8765",
    ]) {
      expect((await adapterFor(site, undefined)).id, site).toBe("well-known");
    }
    for (const repository of [
      "https://github.com/acme/kit",
      "https://www.github.com/acme/kit",
      "https://gitlab.com/acme/kit",
      "https://bitbucket.org/acme/kit",
      "https://git.example.com/acme/kit.git",
      "https://git.example.com/acme/kit.git/",
      "ssh://git@example.com/acme/kit",
      "file:///tmp/kit",
    ]) {
      expect((await adapterFor(repository, undefined)).id, repository).toBe("git");
    }
    expect((await adapterFor("https://git.example.com/acme/kit", "git")).id).toBe("git");
  });

  test("ships only the built-in adapters", async () => {
    registerBuiltinAdapters();
    await expect(loadAdapter("acme")).rejects.toThrow(/Unknown adapter/);
  });

  test("loads a configured origin adapter", async () => {
    registerBuiltinAdapters();
    const home = process.env.AIREG_HOME;
    if (home === undefined) throw new Error("AIREG_HOME was not stubbed");
    const modulePath = join(home, "configured-acme.mjs");
    await writeFile(modulePath, adapterModule("acme", "Configured Acme"));
    await writeFile(join(home, "config.yml"), configYaml("acme", modulePath));
    expect((await loadAdapter("acme")).displayName).toBe("Configured Acme");
  });

  test("ignores a config pin for git", async () => {
    registerBuiltinAdapters();
    const home = process.env.AIREG_HOME;
    if (home === undefined) throw new Error("AIREG_HOME was not stubbed");
    const modulePath = join(home, "fake-git.mjs");
    await writeFile(modulePath, adapterModule("git", "Fake Git"));
    await writeFile(join(home, "config.yml"), configYaml("git", modulePath));
    expect((await loadAdapter("git")).displayName).toBe("Git");
  });

  test("scores a configured adapter from its install record without importing it", async () => {
    registerBuiltinAdapters();
    const home = process.env.AIREG_HOME;
    if (home === undefined) throw new Error("AIREG_HOME was not stubbed");
    const marker = join(home, "imported");
    const modulePath = join(home, "bomb.mjs");
    const source = adapterModule(
      "bomb",
      "Bomb",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "yes");\n`,
    ).replace('hosts: ["configured.example"]', 'hosts: ["bomb.example"]');
    const bytes = new TextEncoder().encode(source);
    await writeFile(modulePath, bytes);
    await writeInstallRecord(modulePath, {
      id: "bomb",
      sha256: sha256Hex(bytes),
      protocol: 1,
      dispatch: { hosts: ["bomb.example"] },
    });
    await writeFile(join(home, "config.yml"), configYaml("bomb", modulePath));

    expect((await adapterFor("https://github.com/acme/kit", undefined)).id).toBe("git");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await adapterFor("https://bomb.example/x", undefined)).id).toBe("bomb");
    expect(await readFile(marker, "utf8")).toBe("yes");
  });

  test("refuses a configured module whose bytes drifted from the install record", async () => {
    registerBuiltinAdapters();
    const home = process.env.AIREG_HOME;
    if (home === undefined) throw new Error("AIREG_HOME was not stubbed");
    const modulePath = join(home, "acme.mjs");
    const source = adapterModule("acme", "Acme");
    await writeFile(modulePath, source);
    await writeInstallRecord(modulePath, {
      id: "acme",
      sha256: sha256Hex(new TextEncoder().encode(source)),
      protocol: 1,
      dispatch: { hosts: ["configured.example"] },
    });
    await writeFile(join(home, "config.yml"), configYaml("acme", modulePath));
    await writeFile(modulePath, `${source}\n`);
    await expect(loadAdapter("acme")).rejects.toThrow(/install record/);
  });

  test("refuses to dispatch a URL past an adapter whose install record is garbage", async () => {
    registerBuiltinAdapters();
    const home = process.env.AIREG_HOME;
    if (home === undefined) throw new Error("AIREG_HOME was not stubbed");
    const modulePath = join(home, "bomb.mjs");
    await writeFile(modulePath, adapterModule("bomb", "Bomb"));
    await writeFile(join(home, "install.json"), "{}\n");
    await writeFile(join(home, "config.yml"), configYaml("bomb", modulePath));

    await expect(adapterFor("https://github.com/acme/kit", undefined)).rejects.toThrow(
      /"bomb" adapter failed to load: .*not a valid install record/,
    );
    await expect(loadAdapter("bomb")).rejects.toThrow(/not a valid install record/);
  });

  test("names a configured adapter that fails to load instead of falling back to git", async () => {
    registerBuiltinAdapters();
    const home = process.env.AIREG_HOME;
    if (home === undefined) throw new Error("AIREG_HOME was not stubbed");
    await writeFile(join(home, "config.yml"), configYaml("acme", join(home, "missing.mjs")));

    await expect(adapterFor("https://acme.example.test/x", undefined)).rejects.toMatchObject({
      message: expect.stringMatching(/"acme" adapter failed to load: /),
      hint: "Fix its module, or remove it with `aireg adapter remove acme`.",
    });
    await expect(adapterFor("/tmp/kit", undefined)).rejects.toThrow(/"acme" adapter/);
    expect((await adapterFor("acme/kit", undefined)).id).toBe("git");
  });

  test("gives git the time AIREG_GIT_TIMEOUT_MS sets, five minutes without it", () => {
    registerBuiltinAdapters();
    expect(limitsFor("git")).toMatchObject({
      timeoutMs: 300_000,
      timeoutSetting: "AIREG_GIT_TIMEOUT_MS",
    });
    vi.stubEnv("AIREG_GIT_TIMEOUT_MS", "100");
    try {
      expect(limitsFor("git").timeoutMs).toBe(100);
      expect(limitsFor("local")).toEqual({ timeoutMs: 30_000, retries: 3 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
