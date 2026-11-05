import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { ADAPTER_PROTOCOL } from "#adapter/index.ts";
import { registerBuiltinAdapter } from "#core/adapter/load.ts";
import { readConfig } from "#core/config/repository.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { ADAPTER_MODULE_FILE } from "#core/product.ts";
import { adapterDataDir, adapterModulePath } from "#core/store/paths.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { installRecordPath, parseInstallRecord } from "./record.ts";
import { adapterSpecifier, unpinAdapter, writeInstalled } from "./store.ts";

// The built-in ids are the ones the composition root registers.
beforeAll(() => {
  registerBuiltinAdapter("git", async () => ({}));
  registerBuiltinAdapter("local", async () => ({}));
});

function adapterSource(id: string, hosts: readonly string[] = ["example.test"]): string {
  return [
    "export default {",
    `  id: ${JSON.stringify(id)},`,
    `  displayName: ${JSON.stringify(id)},`,
    `  protocol: ${ADAPTER_PROTOCOL},`,
    '  artifactKinds: ["skill"],',
    `  dispatch: { hosts: ${JSON.stringify(hosts)} },`,
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

describe("adapter store", () => {
  test("writes the module, an install record, and unpins the managed tree", async () => {
    const bytes = new TextEncoder().encode(adapterSource("acme", ["configured.example"]));
    const specifier = await writeInstalled("acme", "1.4.0", bytes);
    expect(specifier).toBe(adapterSpecifier("acme", "1.4.0"));

    const path = adapterModulePath("acme", "1.4.0", ADAPTER_MODULE_FILE);
    expect(await readFile(path, "utf8")).toBe(adapterSource("acme", ["configured.example"]));
    expect((await readConfig()).adapters.acme).toBe(specifier);

    const record = parseInstallRecord(await readFile(installRecordPath(path), "utf8"));
    expect(record).toEqual({
      id: "acme",
      sha256: sha256Hex(bytes),
      protocol: ADAPTER_PROTOCOL,
      dispatch: { hosts: ["configured.example"] },
    });

    const data = join(adapterDataDir("acme"), "state.db");
    await writeFile(data, "keep");
    await unpinAdapter("acme");
    expect((await readConfig()).adapters.acme).toBeUndefined();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(data, "utf8")).toBe("keep");
  });

  test("deletes the version a newer install replaces", async () => {
    const bytes = new TextEncoder().encode(adapterSource("acme"));
    await writeInstalled("acme", "1.4.0", bytes);
    await writeFile(join(adapterDataDir("acme"), "state.db"), "keep");
    await writeInstalled("acme", "1.5.0", bytes);

    expect((await readConfig()).adapters.acme).toBe(adapterSpecifier("acme", "1.5.0"));
    expect((await readdir(adapterDataDir("acme"))).sort()).toEqual(["1.5.0", "state.db"]);
  });

  test("deletes every installed version on unpin, not only the pinned one", async () => {
    const bytes = new TextEncoder().encode(adapterSource("acme"));
    const left = adapterModulePath("acme", "1.3.0", ADAPTER_MODULE_FILE);
    await mkdir(join(left, ".."), { recursive: true });
    await writeFile(left, "an older install");
    await writeInstalled("acme", "1.4.0", bytes);
    await writeFile(join(adapterDataDir("acme"), "state.db"), "keep");

    await unpinAdapter("acme");
    expect(await readdir(adapterDataDir("acme"))).toEqual(["state.db"]);
  });

  test("refuses to install a built-in adapter", async () => {
    const bytes = new TextEncoder().encode(adapterSource("git"));
    await expect(writeInstalled("git", "1.0.0", bytes)).rejects.toThrow(/built into aireg/);
  });
});
