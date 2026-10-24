import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, vi } from "vitest";
import type {
  PublishInput,
  SourceAdapter,
  SourceContext,
  SourceHandle,
} from "#adapter/contract.ts";
import { ADAPTER } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";

const BODY = new TextEncoder().encode("---\nname: lint\n---\nLints.\n");

/** The development adapter a person can register under `adapters:`, loaded as aireg loads it. */
async function connect(remote: string, namespace: string): Promise<SourceHandle> {
  vi.stubEnv("AIREG_DEV_REMOTE", remote);
  const adapter = ((await import(pathToFileURL(ADAPTER).href)) as { default: SourceAdapter })
    .default;
  const context: SourceContext = {
    source: { registry: "dev", location: "x", config: { namespace }, key: "sha256:k" },
    credential: undefined,
    signal: new AbortController().signal,
    limits: { timeoutMs: 1000, retries: 0 },
    onBytes: () => {},
    cacheDir: () => "",
    exclusive: (_key, run) => run(),
  };
  return adapter.connect(context);
}

function lint(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    name: "lint",
    kind: "skill",
    contentId: "sha256:unused-here",
    files: [{ path: "SKILL.md", content: BODY, executable: false }],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the development adapter", () => {
  test("publishes into its namespace and archives what it unpublishes", async ({ tmp }) => {
    const remote = join(tmp, "remote");
    const handle = await connect(remote, "personal");

    await handle.publish?.([lint()], {});
    const published = join(remote, "personal", "skill", "lint");
    expect(await readFile(join(published, "SKILL.md"))).toEqual(Buffer.from(BODY));

    await handle.unpublish?.([{ id: "skill_lint", kind: "skill" }]);
    expect(existsSync(published)).toBe(false);
    const archived = await readdir(join(remote, "personal", "_archived", "skill"));
    expect(archived).toEqual([expect.stringMatching(/^lint-\d+$/)]);
  });

  test("refuses a namespace that leaves the remote", async ({ tmp }) => {
    const remote = join(tmp, "remote");
    const handle = await connect(remote, "../escaped");

    await expect(handle.publish?.([lint()], {})).rejects.toThrow("The dev adapter refuses");
    expect(existsSync(join(tmp, "escaped"))).toBe(false);
  });

  test("checks every file before it replaces what an artifact held", async ({ tmp }) => {
    const remote = join(tmp, "remote");
    const handle = await connect(remote, "personal");
    await handle.publish?.([lint()], {});

    const bad = lint({ files: [{ path: "a/../../x", content: BODY, executable: false }] });
    await expect(handle.publish?.([bad], {})).rejects.toThrow("The dev adapter refuses");
    expect(await readFile(join(remote, "personal", "skill", "lint", "SKILL.md"))).toEqual(
      Buffer.from(BODY),
    );
  });

  test("refuses an id that would move a folder from outside the remote", async ({ tmp }) => {
    const remote = join(tmp, "remote");
    const victim = join(tmp, "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keep.txt"), "kept\n");
    const handle = await connect(remote, "personal");

    await expect(
      handle.unpublish?.([{ id: "skill_../../../victim", kind: "skill" }]),
    ).rejects.toThrow("The dev adapter refuses");
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(remote, "personal", "_archived"))).toBe(false);
  });

  test("refuses to write through a link out of the remote", async ({ tmp }) => {
    const remote = join(tmp, "remote");
    const outside = join(tmp, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(remote, { recursive: true });
    // A junction on Windows, which needs no privilege to make and reads as a link.
    await symlink(outside, join(remote, "personal"), "junction");
    const handle = await connect(remote, "personal");

    await expect(handle.publish?.([lint()], {})).rejects.toThrow("The dev adapter refuses");
    expect(await readdir(outside)).toEqual([]);
  });
});
