import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { parseVersion } from "#adapter/index.ts";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { parseSource } from "./url.ts";
import { GitVersions, pseudoVersion, readPseudo, releaseTag } from "./versions.ts";

const SHA = "4e1d2c9a8b7f6e5d4c3b2a190817263544536271";
const TIME = new Date(Date.UTC(2026, 9, 19, 12, 0, 5));

describe("pseudoVersion", () => {
  test("follows the nearest tag, and sorts before the next release", () => {
    expect(pseudoVersion(undefined, TIME, SHA)).toBe("0.0.0-20261019120005-4e1d2c9a8b7f");
    expect(pseudoVersion(parseVersion("1.2.0"), TIME, SHA)).toBe(
      "1.2.1-0.20261019120005-4e1d2c9a8b7f",
    );
    expect(pseudoVersion(parseVersion("2.0.0-rc.1"), TIME, SHA)).toBe(
      "2.0.0-rc.1.0.20261019120005-4e1d2c9a8b7f",
    );
  });

  test("is read back by readPseudo, and a release is not one", () => {
    expect(readPseudo("1.2.1-0.20261019120005-4e1d2c9a8b7f")).toEqual({
      stamp: "20261019120005",
      sha: "4e1d2c9a8b7f",
    });
    expect(readPseudo("0.0.0-20261019120005-4e1d2c9a8b7f")?.sha).toBe("4e1d2c9a8b7f");
    expect(readPseudo("1.2.1")).toBeUndefined();
  });
});

describe("releaseTag", () => {
  test("takes the newest release of the whole repository, never a prerelease or one artifact's", () => {
    const tags = [
      { name: "v1.0.0", commit: "a" },
      { name: "1.2.0", commit: "b" },
      { name: "v2.0.0-rc.1", commit: "c" },
      { name: "pdf/v9.0.0", commit: "d" },
      { name: "nightly", commit: "e" },
    ];
    expect(releaseTag(tags)?.tag).toEqual({ name: "1.2.0", commit: "b" });
    expect(releaseTag([{ name: "nightly", commit: "e" }])).toBeUndefined();
  });
});

describe("GitVersions over a repository", () => {
  const limits = { timeoutMs: 30_000 };

  test("serves a tag's version, an artifact's own tag first, and a pseudo-version past it", async ({
    git,
    tmp,
  }) => {
    const repo = await skillsFolder(join(tmp, "repo")).skill("skills/pdf").write();
    await git.init(repo);
    const first = await git.commit(repo, "one");
    await git.tag(repo, "v1.0.0");
    await git.tag(repo, "pdf/v3.0.0");
    await skillsFolder(repo).skill("skills/xlsx").write();
    const second = await git.commit(repo, "two");

    const versions = new GitVersions({
      spec: parseSource(pathToFileURL(repo).href),
      limits,
      cacheDir: () => join(tmp, "cache"),
      exclusive: (_key, run) => run(),
    });
    const at = await versions.versionsAt(first, ["pdf", "xlsx"], repo);
    expect(Object.fromEntries(at)).toEqual({ pdf: "3.0.0", xlsx: "1.0.0" });
    expect(await versions.commitOf("1.0.0", "xlsx")).toBe(first);
    expect(await versions.commitOf("3.0.0", "pdf")).toBe(first);

    const later = await versions.versionsAt(second, ["xlsx"], repo);
    const pseudo = later.get("xlsx") as string;
    expect(pseudo).toMatch(new RegExp(`^1\\.0\\.1-0\\.\\d{14}-${second.slice(0, 12)}$`));
    expect(await versions.commitOf(pseudo, "xlsx")).toBe(second);
    const forged = pseudo.replace(/-0\.(\d{4})/, "-0.1999");
    await expect(versions.commitOf(forged, "xlsx")).rejects.toThrow(
      /has no commit for the version/,
    );
    await expect(versions.commitOf("4.0.0", "pdf")).rejects.toThrow(/has no tag for pdf 4\.0\.0/);
  }, 30_000);
});
