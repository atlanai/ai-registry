import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { emptyLock, type LinkMode, type Lock } from "#core/lock.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";
import type { Plan } from "./model.ts";

let root: string;
let roots: Roots;
let store: string;

test.beforeEach(async ({ tmp }) => {
  root = join(tmp, "project");
  vi.stubEnv("AIREG_HOME", join(tmp, "aireg"));
  roots = makeRoots("project", root);
  store = join(roots.artifacts, "mkt", "ws", "skills", "hello");
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "SKILL.md"), "theirs\n");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function folder(path: string, body: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), body);
}

function lockWith(): Lock {
  const lock = emptyLock();
  lock.artifacts["ws/hello"] = {
    registry: "mkt",
    id: "skill_1",
    name: "hello",
    kind: "skill",
    namespace: "ws",
    address: "ws/skills/hello",
    path: ".registry/artifacts/mkt/ws/skills/hello",
    origin: undefined,
    content: "sha256:c",
    version: "1",
    digest: "sha256:d",
    links: [{ target: "universal", path: ".agents/skills/hello", mode: "symlink" }],
  };
  return lock;
}

function linkPlan(recorded?: LinkMode, copy = false): { plan: Plan; lock: Lock } {
  const lock = lockWith();
  return {
    lock,
    plan: {
      ...emptyPlan(),
      actions: [
        {
          kind: "link",
          name: "ws/hello",
          target: "universal",
          from: store,
          to: join(root, ".agents", "skills", "hello"),
          copy,
          ...(recorded === undefined ? {} : { recorded }),
        },
        { kind: "record", lock },
      ],
    },
  };
}

const fetch = () => Promise.reject(new Error("nothing to fetch"));
const dest = () => join(root, ".agents", "skills", "hello");

describe("a link over something already at its destination", () => {
  test("keeps a folder aireg never linked there, and records no link", async () => {
    await folder(dest(), "MY LOCAL EDIT\n");
    const { plan, lock } = linkPlan();
    const result = await apply(plan, roots, fetch);
    expect((await lstat(dest())).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dest(), "SKILL.md"), "utf8")).toBe("MY LOCAL EDIT\n");
    expect(result.kept).toEqual([{ name: "ws/hello", path: dest() }]);
    expect(lock.artifacts["ws/hello"]?.links).toEqual([]);
  });

  test("keeps a link of the person's own that points outside aireg's folders", async () => {
    const theirs = join(root, "dev", "hello");
    await folder(theirs, "mine\n");
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await symlink(theirs, dest());
    const result = await apply(linkPlan().plan, roots, fetch);
    expect(await readlink(dest())).toBe(theirs);
    expect(result.kept).toHaveLength(1);
  });

  test("backs up a folder that replaced a link aireg made, then links", async () => {
    await folder(dest(), "MY LOCAL EDIT\n");
    const result = await apply(linkPlan("symlink").plan, roots, fetch);
    expect((await lstat(dest())).isSymbolicLink()).toBe(true);
    expect(result.kept).toEqual([]);
    const backups = join(root, ".registry", "backups");
    const [stamp] = await readdir(backups);
    expect(
      await readFile(
        join(backups, stamp ?? "", "universal", "skills", "hello", "SKILL.md"),
        "utf8",
      ),
    ).toBe("MY LOCAL EDIT\n");
  });

  test("replaces a copy aireg made itself", async () => {
    await folder(dest(), "old copy\n");
    await apply(linkPlan("copy", true).plan, roots, fetch);
    expect(await readFile(join(dest(), "SKILL.md"), "utf8")).toBe("theirs\n");
    await expect(lstat(join(root, ".registry", "backups"))).rejects.toThrow();
  });

  test("replaces its own link into the scope folder, and links a free path", async () => {
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await symlink(store, dest());
    await apply(linkPlan().plan, roots, fetch);
    expect((await lstat(dest())).isSymbolicLink()).toBe(true);
    await rm(dest());
    const result = await apply(linkPlan().plan, roots, fetch);
    expect((await lstat(dest())).isSymbolicLink()).toBe(true);
    expect(result.kept).toEqual([]);
  });
});

describe("a destination reached through a target folder that is a link", () => {
  const outside = () => join(root, "outside");

  beforeEach(async () => {
    await folder(join(outside(), "hello"), "NOT AIREG'S\n");
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(outside(), join(root, ".agents", "skills"));
  });

  test("keeps a folder there although the lock records a copy", async () => {
    const result = await apply(linkPlan("copy", true).plan, roots, fetch);
    expect((await lstat(dest())).isSymbolicLink()).toBe(false);
    expect(await readFile(join(outside(), "hello", "SKILL.md"), "utf8")).toBe("NOT AIREG'S\n");
    expect(result.kept).toEqual([{ name: "ws/hello", path: dest() }]);
  });

  test("moves nothing into the backups", async () => {
    const result = await apply(linkPlan("symlink").plan, roots, fetch);
    expect(await readFile(join(outside(), "hello", "SKILL.md"), "utf8")).toBe("NOT AIREG'S\n");
    await expect(lstat(join(root, ".registry", "backups"))).rejects.toThrow();
    expect(result.kept).toHaveLength(1);
  });

  test("still replaces its own link there, as a shared target folder has", async () => {
    await rm(join(outside(), "hello"), { recursive: true });
    await symlink(store, join(outside(), "hello"));
    const result = await apply(linkPlan("symlink").plan, roots, fetch);
    // A Windows junction names its target in full, as the one planted here does.
    if (process.platform !== "win32")
      expect(await readlink(join(outside(), "hello"))).not.toBe(store);
    expect((await lstat(join(outside(), "hello"))).isSymbolicLink()).toBe(true);
    expect(result.kept).toEqual([]);
  });
});

describe("a recorded link going away", () => {
  function unlinkPlan(mode: LinkMode): Plan {
    return {
      ...emptyPlan(),
      actions: [
        { kind: "unlink", name: "ws/hello", to: dest(), link: { target: "universal", mode } },
      ],
    };
  }

  test("moves a folder that replaced the link into the backups, never deletes it", async () => {
    await folder(dest(), "MY LOCAL EDIT\n");
    const result = await apply(unlinkPlan("symlink"), roots, fetch);
    await expect(lstat(dest())).rejects.toThrow();
    const backups = join(root, ".registry", "backups");
    const [stamp] = await readdir(backups);
    const moved = join(backups, stamp ?? "", "universal", "skills", "hello");
    expect(await readFile(join(moved, "SKILL.md"), "utf8")).toBe("MY LOCAL EDIT\n");
    expect(result.backedUp).toEqual([{ path: dest(), to: moved, what: "folder" }]);
  });

  test("moves a second folder from the same path in the same second beside the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T06:22:47.100Z"));
    try {
      await folder(dest(), "FIRST\n");
      const first = await apply(unlinkPlan("symlink"), roots, fetch);
      await folder(dest(), "SECOND\n");
      const second = await apply(unlinkPlan("symlink"), roots, fetch);
      const backups = join(root, ".registry", "backups");
      expect(await readdir(backups)).toEqual(["20261009T062247Z", "20261009T062247Z-2"]);
      const [one, two] = [first.backedUp[0]?.to ?? "", second.backedUp[0]?.to ?? ""];
      expect(await readFile(join(one, "SKILL.md"), "utf8")).toBe("FIRST\n");
      expect(await readFile(join(two, "SKILL.md"), "utf8")).toBe("SECOND\n");
      expect(two).toBe(join(backups, "20261009T062247Z-2", "universal", "skills", "hello"));
    } finally {
      vi.useRealTimers();
    }
  });

  test("removes its own link, and leaves what it pointed at", async () => {
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await symlink(store, dest());
    const result = await apply(unlinkPlan("symlink"), roots, fetch);
    await expect(lstat(dest())).rejects.toThrow();
    expect(await readFile(join(store, "SKILL.md"), "utf8")).toBe("theirs\n");
    expect(result.backedUp).toEqual([]);
  });

  test("removes a copy it made itself", async () => {
    await folder(dest(), "old copy\n");
    const result = await apply(unlinkPlan("copy"), roots, fetch);
    await expect(lstat(dest())).rejects.toThrow();
    expect(result.backedUp).toEqual([]);
  });
});
