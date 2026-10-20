import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Harnesses, RegisterEntry, Target } from "#core/harness/contract.ts";
import { test } from "#test/kit/fixtures.ts";
import { applyRegister } from "./index.ts";

let dir: string;
let home: string;
let root: string;

test.beforeEach(async ({ tmp }) => {
  dir = tmp;
  home = join(dir, ".registry");
  root = join(dir, ".tool");
  await mkdir(join(home, "artifacts"), { recursive: true });
});
function harness(register: RegisterEntry[], place?: "copy"): Harnesses {
  const target: Target = {
    name: "tool",
    displayName: "Tool",
    projectRoot: ".tool",
    userRoot: root,
    envHome: undefined,
    envWithin: undefined,
    detect: { env: [], binary: [], paths: [] },
    kinds: {
      plugin: {
        subdir: "plugins/{source}/{name}",
        shape: "directory",
        register,
        ...(place === undefined ? {} : { place }),
      },
    },
    reads: {},
    kind: "coding",
    shared: false,
    verified: undefined,
    trust: {},
    reload: undefined,
    origin: "built-in",
  };
  return { tool: target };
}

const placement = (source: string, name: string) => join(root, "plugins", source, name);

/** A placement of ours: a link into the scope's folder. */
async function place(source: string, name: string): Promise<string> {
  const at = placement(source, name);
  await mkdir(join(at, ".."), { recursive: true });
  await mkdir(join(home, "artifacts", name), { recursive: true });
  await symlink(join(home, "artifacts", name), at);
  return at;
}

const SETTINGS: RegisterEntry = {
  file: "settings.json",
  format: "json",
  at: ["enabledPlugins"],
  value: { "{name}@{source}": true },
};

const GROUP: RegisterEntry = {
  file: "config.toml",
  format: "toml",
  at: ["sources", "{source}"],
  value: { path: "{root}/plugins/{source}" },
  remove: "entry",
};

const LIST: RegisterEntry = {
  file: "config.yaml",
  format: "yaml",
  at: ["skills", "dirs"],
  append: "{root}/plugins/{source}",
};

const config = () => join(root, "config.yaml");

async function writeConfig(text: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(config(), text);
}

/** A copy of ours, a real folder the lockfile records. */
async function copy(name: string): Promise<string> {
  const path = placement("acme", name);
  await mkdir(path, { recursive: true });
  return path;
}

const placed = (...paths: string[]) => paths.map((path) => ({ path, harness: "tool" }));
const gone = (...paths: string[]) => paths.map((path) => ({ path, harness: undefined }));

describe("applyRegister", () => {
  test("merges a JSON key per placement and leaves a person's keys", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "settings.json"), '{"theme":"dark","enabledPlugins":{"x@y":false}}');
    const sales = await place("acme", "sales");
    const kept = await applyRegister([{ path: sales, harness: "tool" }], harness([SETTINGS]), home);
    expect(kept).toEqual([]);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      enabledPlugins: { "x@y": false, "sales@acme": true },
    });

    await rm(sales);
    await applyRegister([{ path: sales, harness: undefined }], harness([SETTINGS]), home);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      enabledPlugins: { "x@y": false },
    });
  });

  test("registers nothing for a path that is not a link of ours", async () => {
    const theirs = placement("acme", "sales");
    await mkdir(theirs, { recursive: true });
    await applyRegister([{ path: theirs, harness: "tool" }], harness([SETTINGS]), home);
    await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toThrow();
  });

  test("ignores a path no kind of the harness places", async () => {
    const elsewhere = join(dir, "other", "sales");
    await applyRegister([{ path: elsewhere, harness: undefined }], harness([SETTINGS]), home);
    await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toThrow();
  });

  test("refuses a config it cannot parse rather than overwrite it", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "settings.json"), "{ not json");
    const sales = await place("acme", "sales");
    await expect(
      applyRegister([{ path: sales, harness: "tool" }], harness([SETTINGS]), home),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("writes a group entry while any member remains", async () => {
    const sales = await place("acme", "sales");
    const ops = await place("acme", "ops");
    await applyRegister(
      [
        { path: sales, harness: "tool" },
        { path: ops, harness: "tool" },
      ],
      harness([GROUP]),
      home,
    );
    const config = join(root, "config.toml");
    expect(await readFile(config, "utf8")).toBe(
      `[sources.acme]\npath = ${JSON.stringify(join(root, "plugins", "acme"))}\n`,
    );

    await rm(ops);
    await applyRegister([{ path: ops, harness: undefined }], harness([GROUP]), home);
    expect(await readFile(config, "utf8")).toContain("[sources.acme]");

    await rm(sales);
    await applyRegister([{ path: sales, harness: undefined }], harness([GROUP]), home);
    expect(await readFile(config, "utf8")).toBe("");
  });

  test("deletes a TOML file it made once its last entry goes, but not one of comments", async () => {
    const made = { ...GROUP, init: {} };
    const sales = await place("acme", "sales");
    const config = join(root, "config.toml");
    await applyRegister([{ path: sales, harness: "tool" }], harness([made]), home);
    expect(await readFile(config, "utf8")).toContain("[sources.acme]");
    await rm(sales);
    await applyRegister([{ path: sales, harness: undefined }], harness([made]), home);
    await expect(readFile(config, "utf8")).rejects.toThrow();

    await writeFile(config, '# model = "big"\n');
    const ops = await place("acme", "ops");
    await applyRegister([{ path: ops, harness: "tool" }], harness([made]), home);
    await rm(ops);
    await applyRegister([{ path: ops, harness: undefined }], harness([made]), home);
    expect(await readFile(config, "utf8")).toBe('# model = "big"\n');
  });

  test("lists a copy once in YAML, marked as aireg's, and restores the file with the last", async () => {
    const before = "# mine\nmodel: x # pinned\n";
    await writeConfig(before);
    const sales = await copy("sales");
    const ops = await copy("ops");
    await applyRegister(placed(sales, ops), harness([LIST], "copy"), home, new Set([sales, ops]));
    expect(await readFile(config(), "utf8")).toBe(
      `${before}skills:\n  dirs:\n    - ${join(root, "plugins", "acme")} # aireg\n`,
    );

    await rm(ops, { recursive: true });
    await applyRegister(gone(ops), harness([LIST], "copy"), home, new Set([sales]));
    expect(await readFile(config(), "utf8")).toContain("dirs:");

    await rm(sales, { recursive: true });
    await applyRegister(gone(sales), harness([LIST], "copy"), home, new Set());
    expect(await readFile(config(), "utf8")).toBe(before);
  });

  test("leaves a list item a person wrote, even once the last copy goes", async () => {
    const before = `skills:\n  dirs:\n    - ${join(root, "plugins", "acme")} # mine too\n`;
    await writeConfig(before);
    const sales = await copy("sales");
    await applyRegister(placed(sales), harness([LIST], "copy"), home, new Set([sales]));
    expect(await readFile(config(), "utf8")).toBe(before);
    await rm(sales, { recursive: true });
    await applyRegister(gone(sales), harness([LIST], "copy"), home, new Set());
    expect(await readFile(config(), "utf8")).toBe(before);
  });

  test("adds to a YAML file of comments alone, keeping them", async () => {
    await writeConfig("# model: big\n");
    const sales = await copy("sales");
    await applyRegister(placed(sales), harness([LIST], "copy"), home, new Set([sales]));
    const text = await readFile(config(), "utf8");
    expect(text).toMatch(/^# model: big\n/);
    expect(text).toContain(`- ${join(root, "plugins", "acme")} # aireg`);
  });

  test("registers no copy of a kind not placed as copies", async () => {
    const sales = await copy("sales");
    await applyRegister(placed(sales), harness([LIST]), home, new Set([sales]));
    await expect(readFile(config(), "utf8")).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "edits a linked config through its link and keeps its mode",
    async () => {
      const dotfiles = join(dir, "dotfiles");
      await mkdir(dotfiles, { recursive: true });
      await mkdir(root, { recursive: true });
      const real = join(dotfiles, "config.toml");
      await writeFile(real, 'model = "x"\n');
      await chmod(real, 0o600);
      const config = join(root, "config.toml");
      await symlink(real, config);

      const sales = await place("acme", "sales");
      await applyRegister([{ path: sales, harness: "tool" }], harness([GROUP]), home);

      expect((await lstat(config)).isSymbolicLink()).toBe(true);
      expect(await readFile(real, "utf8")).toContain("[sources.acme]");
      expect((await stat(real)).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates a config only its owner can read",
    async () => {
      const sales = await place("acme", "sales");
      await applyRegister([{ path: sales, harness: "tool" }], harness([GROUP]), home);
      expect((await stat(join(root, "config.toml"))).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates the file a link names when it is not there yet",
    async () => {
      await mkdir(root, { recursive: true });
      const real = join(dir, "dotfiles", "config.toml");
      await mkdir(join(dir, "dotfiles"), { recursive: true });
      await symlink(real, join(root, "config.toml"));

      const sales = await place("acme", "sales");
      await applyRegister([{ path: sales, harness: "tool" }], harness([GROUP]), home);

      expect((await lstat(join(root, "config.toml"))).isSymbolicLink()).toBe(true);
      expect((await stat(real)).mode & 0o777).toBe(0o600);
    },
  );
});
