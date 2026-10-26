import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { RegisterEntry, Target, Targets } from "#core/target/contract.ts";
import { test } from "#test/kit/fixtures.ts";
import { applyRegister, type Where } from "./index.ts";

let dir: string;
let home: string;
let root: string;

test.beforeEach(async ({ tmp }) => {
  dir = tmp;
  home = join(dir, ".registry");
  root = join(dir, ".tool");
  await mkdir(join(home, "artifacts"), { recursive: true });
});
function target(register: RegisterEntry[], place?: "copy", scope?: "user"): Targets {
  const tool: Target = {
    name: "tool",
    aliases: [],
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
        ...(scope === undefined ? {} : { scope }),
      },
    },
    reads: {},
    category: "coding-agent",
    shared: false,
    verified: undefined,
    trust: {},
    reload: undefined,
    origin: "built-in",
  };
  return { tool };
}

const placement = (source: string, name: string) => join(root, "plugins", source, name);

/** The user scope, where `target()` keeps its root. */
const user = (): Where => ({ scope: "user", cwd: dir });
/** The project in `dir`, whose `.tool` folder is the same root. */
const project = (): Where => ({ scope: "project", cwd: dir });

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

const placed = (...paths: string[]) => paths.map((path) => ({ path, target: "tool" }));
const gone = (...paths: string[]) => paths.map((path) => ({ path, target: undefined }));

describe("applyRegister", () => {
  test("merges a JSON key per placement and leaves a person's keys", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "settings.json"), '{"theme":"dark","enabledPlugins":{"x@y":false}}');
    const sales = await place("acme", "sales");
    const kept = await applyRegister(
      [{ path: sales, target: "tool" }],
      target([SETTINGS]),
      user(),
      home,
    );
    expect(kept).toEqual([]);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      enabledPlugins: { "x@y": false, "sales@acme": true },
    });

    await rm(sales);
    await applyRegister([{ path: sales, target: undefined }], target([SETTINGS]), user(), home);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      enabledPlugins: { "x@y": false },
    });
  });

  test("registers nothing for a path that is not a link of ours", async () => {
    const theirs = placement("acme", "sales");
    await mkdir(theirs, { recursive: true });
    await applyRegister([{ path: theirs, target: "tool" }], target([SETTINGS]), user(), home);
    await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toThrow();
  });

  test("ignores a path no kind of the target places", async () => {
    const elsewhere = join(dir, "other", "sales");
    await applyRegister([{ path: elsewhere, target: undefined }], target([SETTINGS]), user(), home);
    await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toThrow();
  });

  test("refuses a config it cannot parse rather than overwrite it", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "settings.json"), "{ not json");
    const sales = await place("acme", "sales");
    await expect(
      applyRegister([{ path: sales, target: "tool" }], target([SETTINGS]), user(), home),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("writes a group entry while any member remains", async () => {
    const sales = await place("acme", "sales");
    const ops = await place("acme", "ops");
    await applyRegister(
      [
        { path: sales, target: "tool" },
        { path: ops, target: "tool" },
      ],
      target([GROUP]),
      user(),
      home,
    );
    const config = join(root, "config.toml");
    expect(await readFile(config, "utf8")).toBe(
      `[sources.acme]\npath = ${JSON.stringify(join(root, "plugins", "acme"))}\n`,
    );

    await rm(ops);
    await applyRegister([{ path: ops, target: undefined }], target([GROUP]), user(), home);
    expect(await readFile(config, "utf8")).toContain("[sources.acme]");

    await rm(sales);
    await applyRegister([{ path: sales, target: undefined }], target([GROUP]), user(), home);
    expect(await readFile(config, "utf8")).toBe("");
  });

  test("deletes a TOML file it made once its last entry goes, but not one of comments", async () => {
    const made = { ...GROUP, init: {} };
    const sales = await place("acme", "sales");
    const config = join(root, "config.toml");
    await applyRegister([{ path: sales, target: "tool" }], target([made]), user(), home);
    expect(await readFile(config, "utf8")).toContain("[sources.acme]");
    await rm(sales);
    await applyRegister([{ path: sales, target: undefined }], target([made]), user(), home);
    await expect(readFile(config, "utf8")).rejects.toThrow();

    await writeFile(config, '# model = "big"\n');
    const ops = await place("acme", "ops");
    await applyRegister([{ path: ops, target: "tool" }], target([made]), user(), home);
    await rm(ops);
    await applyRegister([{ path: ops, target: undefined }], target([made]), user(), home);
    expect(await readFile(config, "utf8")).toBe('# model = "big"\n');
  });

  test("lists a copy once in YAML, marked as aireg's, and restores the file with the last", async () => {
    const before = "# mine\nmodel: x # pinned\n";
    await writeConfig(before);
    const sales = await copy("sales");
    const ops = await copy("ops");
    await applyRegister(
      placed(sales, ops),
      target([LIST], "copy"),
      user(),
      home,
      new Set([sales, ops]),
    );
    expect(await readFile(config(), "utf8")).toBe(
      `${before}skills:\n  dirs:\n    - ${join(root, "plugins", "acme")} # aireg\n`,
    );

    await rm(ops, { recursive: true });
    await applyRegister(gone(ops), target([LIST], "copy"), user(), home, new Set([sales]));
    expect(await readFile(config(), "utf8")).toContain("dirs:");

    await rm(sales, { recursive: true });
    await applyRegister(gone(sales), target([LIST], "copy"), user(), home, new Set());
    expect(await readFile(config(), "utf8")).toBe(before);
  });

  test("leaves a list item a person wrote, even once the last copy goes", async () => {
    const before = `skills:\n  dirs:\n    - ${join(root, "plugins", "acme")} # mine too\n`;
    await writeConfig(before);
    const sales = await copy("sales");
    await applyRegister(placed(sales), target([LIST], "copy"), user(), home, new Set([sales]));
    expect(await readFile(config(), "utf8")).toBe(before);
    await rm(sales, { recursive: true });
    await applyRegister(gone(sales), target([LIST], "copy"), user(), home, new Set());
    expect(await readFile(config(), "utf8")).toBe(before);
  });

  test("adds to a YAML file of comments alone, keeping them", async () => {
    await writeConfig("# model: big\n");
    const sales = await copy("sales");
    await applyRegister(placed(sales), target([LIST], "copy"), user(), home, new Set([sales]));
    const text = await readFile(config(), "utf8");
    expect(text).toMatch(/^# model: big\n/);
    expect(text).toContain(`- ${join(root, "plugins", "acme")} # aireg`);
  });

  test("registers no copy of a kind not placed as copies", async () => {
    const sales = await copy("sales");
    await applyRegister(placed(sales), target([LIST]), user(), home, new Set([sales]));
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
      await applyRegister([{ path: sales, target: "tool" }], target([GROUP]), user(), home);

      expect((await lstat(config)).isSymbolicLink()).toBe(true);
      expect(await readFile(real, "utf8")).toContain("[sources.acme]");
      expect((await stat(real)).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates a config only its owner can read",
    async () => {
      const sales = await place("acme", "sales");
      await applyRegister([{ path: sales, target: "tool" }], target([GROUP]), user(), home);
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
      await applyRegister([{ path: sales, target: "tool" }], target([GROUP]), user(), home);

      expect((await lstat(join(root, "config.toml"))).isSymbolicLink()).toBe(true);
      expect((await stat(real)).mode & 0o777).toBe(0o600);
    },
  );
});

const settingsIn = (folder: string): RegisterEntry => ({
  ...SETTINGS,
  file: `${folder}/settings.json`,
});

describe("applyRegister, kept to the run's target roots", () => {
  test("registers no kind another scope loads", async () => {
    const sales = await place("acme", "sales");
    const userOnly = target([SETTINGS], undefined, "user");

    // The project's target root is this same folder, but the kind is the user scope's.
    await applyRegister([{ path: sales, target: "tool" }], userOnly, project(), home);
    await expect(readFile(join(root, "settings.json"), "utf8")).rejects.toThrow();

    await applyRegister([{ path: sales, target: "tool" }], userOnly, user(), home);
    expect(await readFile(join(root, "settings.json"), "utf8")).toContain("sales@acme");
  });

  test("edits no config beside a path that only ends the way a placement does", async () => {
    const elsewhere = join(dir, "other");
    const at = join(elsewhere, "plugins", "acme", "sales");
    await mkdir(join(at, ".."), { recursive: true });
    await mkdir(join(home, "artifacts", "sales"), { recursive: true });
    await symlink(join(home, "artifacts", "sales"), at);

    await applyRegister([{ path: at, target: "tool" }], target([SETTINGS]), user(), home);
    await expect(readFile(join(elsewhere, "settings.json"), "utf8")).rejects.toThrow();
  });

  test("cleans up a removal only for the target the lockfile recorded it for", async () => {
    const sales = await place("acme", "sales");
    await applyRegister([{ path: sales, target: "tool" }], target([SETTINGS]), user(), home);
    await rm(sales);
    const settings = join(root, "settings.json");

    const other = { path: sales, target: undefined, recorded: "other" };
    await applyRegister([other], target([SETTINGS]), user(), home);
    expect(await readFile(settings, "utf8")).toContain("sales@acme");

    const ours = { path: sales, target: undefined, recorded: "tool" };
    await applyRegister([ours], target([SETTINGS]), user(), home);
    expect(await readFile(settings, "utf8")).not.toContain("sales@acme");
  });

  test.skipIf(process.platform === "win32")(
    "edits no config through a project's target root that links out of it",
    async () => {
      const victim = join(dir, "victim");
      await mkdir(join(victim, "plugins", "acme"), { recursive: true });
      const config = '{"enabledPlugins":{"sales@acme":true}}';
      await writeFile(join(victim, "settings.json"), config);
      await symlink(victim, root);
      const sales = placement("acme", "sales");

      const kept = await applyRegister(
        [{ path: sales, target: undefined, recorded: "tool" }],
        target([SETTINGS]),
        project(),
        home,
      );

      expect(await readFile(join(victim, "settings.json"), "utf8")).toBe(config);
      expect(kept).toEqual([
        expect.objectContaining({ path: join(root, "settings.json"), reason: expect.any(String) }),
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "edits no config through a link below the target root, and still through a linked root",
    async () => {
      const dotfiles = join(dir, "dotfiles");
      const outside = join(dir, "outside");
      await mkdir(dotfiles, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(dotfiles, root);
      await symlink(outside, join(dotfiles, "nested"));
      const sales = await place("acme", "sales");

      const kept = await applyRegister(
        [{ path: sales, target: "tool" }],
        target([settingsIn("real"), settingsIn("nested")]),
        user(),
        home,
      );

      expect(await readFile(join(dotfiles, "real", "settings.json"), "utf8")).toContain(
        "sales@acme",
      );
      await expect(readFile(join(outside, "settings.json"), "utf8")).rejects.toThrow();
      expect(kept.map((entry) => entry.path)).toEqual([join(root, "nested", "settings.json")]);
    },
  );
});
