import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { emptyLock, type Lock } from "#core/lock.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";
import type { Action, Plan } from "./model.ts";

let home: string;
let roots: Roots;
let config: string;

// The test home sets CODEX_HOME, and removal is confined to the target folders it names.
test.beforeEach(async ({ home: made }) => {
  home = made.dir;
  roots = makeRoots("user", home);
  config = join(home, ".codex", "config.toml");
});

const cache = (source: string) => join(home, ".codex", "plugins", "cache", source);
const index = (source: string) => join(cache(source), ".agents", "plugins", "marketplace.json");

/** Laid out as `assemble` leaves it: manifests of its own, kind directories linked to the content. */
async function projected(source: string, plugin: string): Promise<string> {
  const dir = join(roots.artifacts, ".projections", source, plugin);
  const content = join(roots.artifacts, source, plugin, "skills");
  await mkdir(join(content, "hello"), { recursive: true });
  await mkdir(join(dir, ".codex-plugin"), { recursive: true });
  await writeFile(join(dir, ".codex-plugin", "plugin.json"), `{"name":"${plugin}"}`);
  await symlink(relative(dir, content), join(dir, "skills"));
  return dir;
}

function linkTo(source: string, plugin: string, from: string): Extract<Action, { kind: "link" }> {
  return {
    kind: "link",
    name: `${source}/${plugin}/skill/hello`,
    target: "codex",
    from,
    to: join(cache(source), plugin, "local"),
    copy: false,
    fan: true,
  };
}

function unlinkOf(source: string, plugin: string): Action {
  return {
    kind: "unlink",
    name: `${source}/${plugin}/skill/hello`,
    to: join(cache(source), plugin, "local"),
  };
}

const plan = (actions: Action[]): Plan => ({ ...emptyPlan(), actions });
const noFetch = () => Promise.reject(new Error("nothing is staged"));

describe("codex plugins as a local marketplace", () => {
  test("places a real directory Codex will load, and lists it in a marketplace of its own", async () => {
    const sales = await projected("acme-prod", "sales");
    const ops = await projected("acme-prod", "ops");
    const result = await apply(
      plan([linkTo("acme-prod", "sales", sales), linkTo("acme-prod", "ops", ops)]),
      roots,
      noFetch,
    );

    const local = join(cache("acme-prod"), "sales", "local");
    expect((await lstat(local)).isDirectory()).toBe(true);
    // The manifest is a real file: a newer Codex refuses one reached through a link.
    expect((await lstat(join(local, ".codex-plugin"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(local, "skills"))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(local, "skills"))).toBe(
      join(roots.artifacts, "acme-prod", "sales", "skills"),
    );
    expect(result.kept).toEqual([]);

    expect(JSON.parse(await readFile(index("acme-prod"), "utf8"))).toEqual({
      name: "acme-prod",
      plugins: [
        { name: "ops", source: { path: "./ops/local", source: "local" } },
        { name: "sales", source: { path: "./sales/local", source: "local" } },
      ],
    });
    const text = await readFile(config, "utf8");
    expect(text).toContain(
      `[marketplaces.acme-prod]\nsource_type = "local"\nsource = ${JSON.stringify(cache("acme-prod"))}\n`,
    );
    expect(text).toContain('[plugins."sales@acme-prod"]\nenabled = true');
  });

  test("drops a removed plugin from the index, and the marketplace with its last one", async () => {
    const sales = await projected("acme-prod", "sales");
    const ops = await projected("acme-prod", "ops");
    await apply(
      plan([linkTo("acme-prod", "sales", sales), linkTo("acme-prod", "ops", ops)]),
      roots,
      noFetch,
    );

    await apply(plan([unlinkOf("acme-prod", "ops")]), roots, noFetch);
    expect(JSON.parse(await readFile(index("acme-prod"), "utf8")).plugins).toEqual([
      { name: "sales", source: { path: "./sales/local", source: "local" } },
    ]);
    await expect(lstat(join(cache("acme-prod"), "ops"))).rejects.toThrow();

    await apply(plan([unlinkOf("acme-prod", "sales")]), roots, noFetch);
    await expect(lstat(join(cache("acme-prod"), ".agents"))).rejects.toThrow();
    // aireg made config.toml, so it goes with the last entry it held.
    await expect(lstat(config)).rejects.toThrow();
  });

  test("leaves a marketplace of the same name a person added alone", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    const theirs = `[marketplaces.acme-prod]\nsource_type = "git"\nsource = "https://example.com/acme.git"\n`;
    await writeFile(config, theirs);
    const sales = await projected("acme-prod", "sales");
    const result = await apply(plan([linkTo("acme-prod", "sales", sales)]), roots, noFetch);

    const text = await readFile(config, "utf8");
    expect(text.startsWith(theirs)).toBe(true);
    expect(text.match(/\[marketplaces\.acme-prod\]/g)).toHaveLength(1);
    await expect(lstat(index("acme-prod"))).rejects.toThrow();
    expect(result.kept).toEqual([{ name: "acme-prod", path: config }]);
  });

  test("records the new mode for every artifact that shares the plugin it relinked", async () => {
    const sales = await projected("acme-prod", "sales");
    const local = join(cache("acme-prod"), "sales", "local");
    const row = (name: string): Lock["artifacts"][string] => ({
      registry: "acme-prod",
      id: undefined,
      name,
      kind: "skill",
      namespace: "sales",
      address: undefined,
      content: undefined,
      version: undefined,
      path: `artifacts/acme-prod/sales/skills/${name}`,
      digest: "",
      origin: undefined,
      links: [{ target: "codex", path: relative(roots.base, local), mode: "copy" }],
    });
    const lock: Lock = emptyLock();
    lock.artifacts["acme-prod/sales/skill/hello"] = row("hello");
    lock.artifacts["acme-prod/sales/skill/pitch"] = row("pitch");

    // One plugin directory, so the planner relinks it once, for the first artifact.
    await apply(
      plan([linkTo("acme-prod", "sales", sales), { kind: "record", lock }]),
      roots,
      noFetch,
    );
    const written = await readFile(roots.lock, "utf8");
    expect(written.match(/mode: fanout/g)).toHaveLength(2);
    expect(written).not.toContain("mode: copy");
  });
});
