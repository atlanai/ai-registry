import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import {
  emptyLock,
  formatLock,
  LOCK_VERSION,
  type Lock,
  type LockArtifact,
  LockError,
  parseLock,
  readLock,
} from "./lock.ts";

function lock(): Lock {
  return {
    version: LOCK_VERSION,
    registries: {
      kit: {
        location: "acme/kit",
        adapter: "git",
        key: "sha256:kit",
        config: {},
        revision: "a".repeat(40),
      },
    },
    artifacts: {
      review: {
        registry: "kit",
        id: "skills/review",
        name: "review",
        kind: "skill",
        namespace: undefined,
        address: "skills/review",
        path: "artifacts/copy",
        origin: undefined,
        content: "sha256:r",
        version: undefined,
        digest: "sha256:1",
        links: [{ harness: "claude", path: ".claude/skills/review", mode: "symlink" }],
      },
      lint: {
        registry: "kit",
        id: "skills/lint",
        name: "lint",
        kind: "skill",
        namespace: undefined,
        address: "skills/lint",
        path: "artifacts/copy",
        origin: undefined,
        content: "sha256:l",
        version: undefined,
        digest: "sha256:2",
        links: [],
      },
    },
  };
}

describe("formatLock", () => {
  test("sorts artifacts so the diff is stable", () => {
    const text = formatLock(lock());
    expect(text.indexOf("lint:")).toBeLessThan(text.indexOf("review:"));
  });

  test("carries no timestamp, so concurrent branches merge cleanly", () => {
    expect(formatLock(lock())).not.toMatch(/generated_?at|timestamp|\d{4}-\d{2}-\d{2}T/i);
  });

  test("round-trips byte for byte, keeping every source and artifact field", () => {
    const hosted = {
      location: "https://registry.example.test",
      adapter: "acme",
      key: "sha256:hosted",
      config: { team: "platform" },
      revision: undefined,
    };
    const value = lock();
    value.registries.hosted = hosted;
    const once = formatLock(value);
    expect(formatLock(parseLock(once))).toBe(once);

    const back = parseLock(once);
    expect(back.registries).toEqual(value.registries);
    expect(back.artifacts.review).toEqual(value.artifacts.review);
    expect(back.artifacts.lint).toEqual(value.artifacts.lint);
  });

  test("records a revision once per source, not once per artifact", () => {
    expect(formatLock(lock()).match(/revision:/g)).toHaveLength(1);
  });
});

describe("parseLock", () => {
  test("refuses a lock it cannot read rather than reading it as empty", () => {
    // Read as empty, the next install would overwrite every edit the lock protects.
    expect(() => parseLock(`<<<<<<< HEAD\n${formatLock(lock())}`)).toThrow(/merge conflict/);
    expect(() => parseLock("version: 1\nartifacts: [\n")).toThrow(LockError);
    expect(() => parseLock("[]")).toThrow(LockError);
  });

  test("reads an empty file as an empty lock", () => {
    expect(parseLock("")).toEqual(emptyLock());
  });

  test("drops an artifact whose source is gone", () => {
    const text =
      "version: 1\nregistries: {}\nartifacts:\n  a:\n    registry: missing\n    kind: skill\n    name: a\n";
    expect(Object.keys(parseLock(text).artifacts)).toEqual([]);
  });

  test("refuses a section or a row it cannot read rather than dropping it", () => {
    const head = "version: 1\nregistries:\n  kit: {source: x, adapter: git, key: k}\n";
    const row = (extra: string) =>
      `${head}artifacts:\n  lint:\n    registry: kit\n    name: lint\n${extra}`;
    expect(() => parseLock("version: 1\nregistries: hello\n")).toThrow(
      /`registries:` that is not a mapping/,
    );
    expect(() => parseLock(`${head}artifacts: [lint]\n`)).toThrow(
      /`artifacts:` that is not a mapping/,
    );
    expect(() => parseLock("version: 1\nregistries:\n  kit: {source: x}\n")).toThrow(
      /registry "kit" it cannot read/,
    );
    expect(() => parseLock(row(""))).toThrow(/artifact "lint" it cannot read/);
    const linked = (mode: string) =>
      row(
        `    kind: skill\n    links:\n      - {harness: claude, path: .claude/skills/lint, mode: ${mode}}\n`,
      );
    expect(parseLock(linked("copy")).artifacts.lint?.links[0]?.mode).toBe("copy");
    expect(() => parseLock(linked("hardlink"))).toThrow(/artifact "lint" it cannot read/);
    expect(() => parseLock(row("    kind: skill\n    origin: here\n"))).toThrow(
      /artifact "lint" it cannot read/,
    );
  });
  test("refuses a row whose names or paths would reach outside the scope", () => {
    const head = "version: 1\nregistries:\n  kit: {source: x, adapter: git, key: k}\n";
    const row = (key: string, fields: string) =>
      `${head}artifacts:\n  ${JSON.stringify(key)}:\n    registry: kit\n    kind: skill\n${fields}`;
    const named = (name: string) => row("lint", `    name: ${JSON.stringify(name)}\n`);
    const at = (field: string) => row("lint", `    name: lint\n${field}`);
    expect(parseLock(named("lint")).artifacts.lint?.name).toBe("lint");
    expect(parseLock(row("eng/lint", "    name: lint\n")).artifacts["eng/lint"]).toBeDefined();
    for (const text of [
      named("../../.claude/skills/wip"),
      named("a\\b"),
      named(".."),
      row("..", "    name: lint\n"),
      at("    path: ../outside\n"),
      at("    path: /etc\n"),
      at("    links:\n      - {harness: claude, path: ../../.claude/skills/x, mode: symlink}\n"),
      at("    links:\n      - {harness: claude, path: /abs/x, mode: symlink}\n"),
      at("    origin: {harness: claude, path: .claude\\skills\\x, step: s}\n"),
    ]) {
      expect(() => parseLock(text), text).toThrow(/it cannot read/);
    }
  });
});

describe("lock version", () => {
  test("refuses a lock a newer aireg wrote, and says how to read it", () => {
    const ahead = formatLock(lock()).replace(`version: ${LOCK_VERSION}`, "version: 99");
    expect(() => parseLock(ahead)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("version 99"),
        hint: expect.stringContaining("aireg self update"),
      }),
    );
  });

  test("keeps what needs an artifact through a round trip, in order", () => {
    const value = lock();
    value.artifacts.lint = { ...(value.artifacts.lint as LockArtifact), neededBy: ["z", "review"] };
    const text = formatLock(value);
    expect(text).toContain("needed_by:\n      - review\n      - z");
    expect(parseLock(text).artifacts.lint?.neededBy).toEqual(["review", "z"]);
    expect(parseLock(text).artifacts.review?.neededBy).toBeUndefined();
  });
});

describe("reading a lock", () => {
  const lock = [
    "version: 1",
    "registries:",
    "  kit:",
    "    source: https://example.test",
    "    adapter: git",
    '    key: "sha256:1111111111111111111111111111111111111111111111111111111111111111"',
    "artifacts:",
    "  lint:",
    "    registry: kit",
    "    id: skills/lint",
    "    name: lint",
    "    kind: skill",
    "    path: skills/lint",
    '    content: "sha256:2222222222222222222222222222222222222222222222222222222222222222"',
    '    digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333"',
    "    links:",
    "      - harness: claude",
    "        path: .claude/skills/lint",
    "        mode: symlink",
    "",
  ].join("\n");

  test("round-trips `registries:`, `registry:` and `source:`", () => {
    const written = formatLock(parseLock(lock));
    expect(written.startsWith("# Generated by aireg. Do not edit.\n")).toBe(true);
    expect(parseLock(written)).toEqual(parseLock(lock));
    expect(parseLock(lock).registries.kit?.location).toBe("https://example.test");
  });
});

const at = (lock: string) => ({ scope: "project" as const, lock });

describe("paths outside the scope", () => {
  const lock = (path: string) =>
    `version: ${LOCK_VERSION}\nregistries:\n  kit: {source: x, adapter: git, key: k}\nartifacts:\n  lint:\n    registry: kit\n    name: lint\n    kind: skill\n    path: ${path}\n`;

  test("are refused in a project's committed lock", () => {
    expect(() => parseLock(lock("../elsewhere/lint"))).toThrow(LockError);
  });

  test("are read in the user's own lock, whose scope may sit outside HOME", () => {
    const read = parseLock(lock("../elsewhere/lint"), "The lockfile", "user");
    expect(read.artifacts.lint?.path).toBe("../elsewhere/lint");
  });
});

describe("readLock", () => {
  test("reads a missing lock as empty, the only state that means nothing is installed", async ({
    tmp,
  }) => {
    const dir = tmp;
    expect(await readLock(at(join(dir, "manifest.lock.yml")))).toEqual(emptyLock());
    await expect(readLock(at(dir))).rejects.toThrow(LockError);
  });
});

describe("names that reach a prototype", () => {
  test("are only ever keys", async ({ tmp }) => {
    const path = join(tmp, "manifest.lock.yml");
    const row = (name: string) =>
      `  ${name}:\n    registry: kit\n    name: ${name}\n    kind: skill\n`;
    await writeFile(
      path,
      `version: ${LOCK_VERSION}\nregistries:\n  kit: {source: x, adapter: git, key: k}\nartifacts:\n${row("__proto__")}${row("prototype")}`,
    );
    const read = await readLock(at(path));
    expect(Object.keys(read.artifacts).sort()).toEqual(["__proto__", "prototype"]);
    expect(read.artifacts.constructor).toBeUndefined();
    expect(emptyLock().artifacts.constructor).toBeUndefined();
    const again = parseLock(formatLock(read)).artifacts;
    expect(Object.values(again).map((row) => row.name)).toEqual(["__proto__", "prototype"]);
  });
});
