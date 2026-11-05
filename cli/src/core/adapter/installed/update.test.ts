import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { readConfig, writeConfig } from "#core/config/repository.ts";
import { test } from "#test/kit/fixtures.ts";
import type { AdapterRelease } from "./fetch.ts";
import { originVersion, updateAdapters } from "./update.ts";

let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});
const stamp = () => ({
  origin: "https://releases.example.com",
  channel: "stable" as const,
  keys: new Map(),
});

async function homeWith(adapters: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const home = join(scratch, "home");
  await mkdir(home);
  const env = { AIREG_HOME: home };
  const current = await readConfig(env);
  await writeConfig({ ...current, adapters }, current.revision, env);
  return env;
}

function head(version: string) {
  return vi.fn(
    async (want: { id: string }): Promise<AdapterRelease> => ({
      id: want.id,
      version,
      plan: { kind: "manifest", url: "", name: "adapter.mjs", sha256: "", size: 0 },
    }),
  );
}

describe("originVersion", () => {
  test("reads the version of an origin install and ignores a hand-written path", () => {
    expect(originVersion("acme", "./adapters/acme/1.2.0/adapter.mjs")).toBe("1.2.0");
    expect(originVersion("acme", "./adapters/other/1.2.0/adapter.mjs")).toBeUndefined();
    expect(originVersion("acme", "/Users/me/acme/dist/adapter.mjs")).toBeUndefined();
  });
});

describe("updateAdapters", () => {
  test("installs a newer channel head and leaves current and local adapters alone", async () => {
    const env = await homeWith({
      acme: "./adapters/acme/1.0.0/adapter.mjs",
      beta: "./adapters/beta/2.0.0/adapter.mjs",
      mine: "/Users/me/mine/adapter.mjs",
    });
    const install = vi.fn(async () => "");
    const resolve = vi.fn(async (want: { id: string }) =>
      head(want.id === "acme" ? "1.1.0" : "2.0.0")(want),
    );
    const updated = await updateAdapters(env, {
      stamp,
      resolve,
      download: async () => new Uint8Array(),
      install,
    });
    expect(updated).toEqual(["acme 1.1.0"]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledWith("acme", "1.1.0", expect.any(Uint8Array), env);
  });

  test("keeps the pinned version when the head will not install, and reports why", async () => {
    const env = await homeWith({ acme: "./adapters/acme/1.0.0/adapter.mjs" });
    const failed: [string, unknown][] = [];
    const updated = await updateAdapters(env, {
      stamp,
      resolve: head("1.1.0"),
      download: async () => new Uint8Array(),
      install: async () => {
        throw new Error("acme advertised an unsupported protocol");
      },
      onFailure: (id, error) => failed.push([id, error]),
    });
    expect(updated).toEqual([]);
    expect(failed).toEqual([["acme", new Error("acme advertised an unsupported protocol")]]);
  });

  test("does nothing for a build with no release origin", async () => {
    const env = await homeWith({ acme: "./adapters/acme/1.0.0/adapter.mjs" });
    const resolve = head("1.1.0");
    expect(await updateAdapters(env, { stamp: () => undefined, resolve })).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
