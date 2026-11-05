import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { declared, lockPath, manifestPath } from "#test/kit/scope.ts";

let aireg: Aireg;
let root: string;
let market: string;
let project: string;

/**
 * Republishes the whole root, which is how a registry gains a version. `lint`
 * can be given other bytes or yanked; `format` is published beside it.
 */
async function publish(
  versions: readonly string[],
  lint: { rewrite?: string; yank?: string } = {},
): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" });
  for (const version of versions) {
    const extra = version === lint.rewrite ? " rewritten" : "";
    built.skill(`acme/lint@${version}`, { body: `body ${version}${extra}\n` });
  }
  for (const version of versions)
    built.skill(`acme/format@${version}`, { body: `body ${version}\n` });
  if (lint.yank !== undefined && versions.includes(lint.yank)) {
    built.yank(`acme/lint@${lint.yank}`, "broken");
  }
  await built.write();
}

const installed = (name = "lint") =>
  readFile(join(project, ".claude", "skills", name, "SKILL.md"), "utf8");
const manifest = () => readFile(manifestPath(project), "utf8");
const lockedVersion = async (name = "lint"): Promise<string | undefined> => {
  const lock = parse(await readFile(lockPath(project), "utf8")) as {
    artifacts: Record<string, { version?: string }>;
  };
  return lock.artifacts[name]?.version;
};
/** A checkout that commits the lock but not what it installs, as CI sees it. */
const withoutCopies = async () => {
  await rm(join(project, ".registry", "artifacts"), { recursive: true, force: true });
  await rm(join(project, ".claude", "skills"), { recursive: true, force: true });
};

test.beforeAll(async ({ aireg: run, tmp, project: dir }) => {
  [aireg, root, market, project] = [run, tmp, join(tmp, "market"), dir];
  await mkdir(join(project, ".claude"), { recursive: true });

  await publish(["1.0.0", "1.1.0", "2.0.0"]);
  expect((await aireg(["init", "-y"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
});

// A version is asked for in the manifest and answered in the lock, so these
// assert both: what the manifest holds, and which bytes arrived.
describe("a version a project asks for", () => {
  test("installs the one named, not the newest", async () => {
    expect((await aireg(["add", "acme/skill/lint@1.0.0", "-y"])).code).toBe(0);
    expect(await installed()).toContain("body 1.0.0");
    expect(await manifest()).toContain("acme/acme/skill/lint@1.0.0");
    expect(await lockedVersion()).toBe("1.0.0");
  });

  test("holds that version when the registry publishes a newer one", async () => {
    await publish(["1.0.0", "1.1.0", "2.0.0", "3.0.0"]);
    const update = await aireg(["update", "-y"]);
    expect(update.code).toBe(0);
    // Silence here would read exactly like an update that worked.
    expect(update.stderr).toContain("stays at 1.0.0");
    expect(await installed()).toContain("body 1.0.0");
    expect(await lockedVersion()).toBe("1.0.0");
  });

  test("reports the newer version without calling a holding pin drift", async () => {
    const outdated = await aireg(["outdated"]);
    expect(outdated.code).toBe(0);
    expect(outdated.stdout).toContain("1.0.0");
    expect(outdated.stdout).toContain("3.0.0");
    expect(outdated.stdout).toContain("pinned");
  });

  test("re-pins in place rather than declaring the artifact twice", async () => {
    expect((await aireg(["add", "acme/skill/lint@2.0.0", "-y"])).code).toBe(0);
    const text = declared(await manifest());
    expect(text).toContain("acme/acme/skill/lint@2.0.0");
    expect(text).not.toContain("@1.0.0");
    expect(text.match(/skill\/lint/g)).toHaveLength(1);
    expect(await installed()).toContain("body 2.0.0");
    expect(await lockedVersion()).toBe("2.0.0");
  });

  test("tracks latest again once the pin is dropped", async () => {
    expect((await aireg(["add", "acme/skill/lint", "-y"])).code).toBe(0);
    expect(await manifest()).not.toContain("@");
    expect(await installed()).toContain("body 3.0.0");
    expect(await lockedVersion()).toBe("3.0.0");
  });

  test("follows the registry forward when nothing is pinned", async () => {
    await publish(["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0"]);
    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect(await installed()).toContain("body 4.0.0");
    expect(await lockedVersion()).toBe("4.0.0");
  });

  test("refuses a version the registry does not publish, and changes nothing", async () => {
    const before = await manifest();
    const failed = await aireg(["add", "acme/skill/lint@9.9.9", "-y"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("no version 9.9.9");
    expect(await manifest()).toBe(before);
    expect(await installed()).toContain("body 4.0.0");
  });

  test("refuses to pin anything broader than one artifact", async () => {
    for (const ref of ["acme@1.0.0", "acme/acme@1.0.0"]) {
      const failed = await aireg(["add", ref, "-y"]);
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain("only one artifact can be pinned to a version");
    }
  });

  test("refuses a new pin to a yanked version, says why, and changes nothing", async () => {
    const versions = ["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0"];
    await publish(versions, { yank: "2.0.0" });
    const before = await manifest();
    const failed = await aireg(["add", "acme/skill/lint@2.0.0", "-y"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('"lint" 2.0.0 is yanked (broken)');
    expect(failed.stderr).not.toContain("stays installed");
    expect(await manifest()).toBe(before);
    expect(await lockedVersion()).toBe("4.0.0");
    expect(await installed()).toContain("body 4.0.0");
    await publish(versions);
  });
});

describe("installing from the lock", () => {
  test("installs what the lock holds after the registry publishes a newer version", async () => {
    await publish(["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"]);
    expect((await aireg(["install", "-y"])).code).toBe(0);
    expect(await installed()).toContain("body 4.0.0");
    expect(await lockedVersion()).toBe("4.0.0");
  });

  test("needs no registry when everything the lock holds is installed", async () => {
    await rename(market, `${market}.away`);
    try {
      expect((await aireg(["install", "-y"])).code).toBe(0);
    } finally {
      await rename(`${market}.away`, market);
    }
  });

  test("installs a checkout without copies under --frozen, and leaves the lock as it was", async () => {
    const before = await readFile(lockPath(project), "utf8");
    await withoutCopies();
    expect((await aireg(["install", "--frozen", "-y"])).code).toBe(0);
    expect(await installed()).toContain("body 4.0.0");
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
  });

  test("fails --frozen once the lock would change, and names what would", async () => {
    const before = await manifest();
    await writeFile(
      manifestPath(project),
      before.replace("acme/acme/skill/lint", "acme/acme/skill/lint@5.0.0"),
    );
    try {
      const frozen = await aireg(["install", "--frozen", "-y"]);
      expect(frozen.code).toBe(3);
      expect(frozen.stderr).toContain("The lockfile would change for lint");
    } finally {
      await writeFile(manifestPath(project), before);
    }
  });

  test("moves only the artifact update names", async () => {
    expect((await aireg(["add", "acme/skill/format", "-y"])).code).toBe(0);
    await publish(["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"]);
    expect((await aireg(["update", "lint", "-y"])).code).toBe(0);
    expect(await lockedVersion("lint")).toBe("6.0.0");
    expect(await lockedVersion("format")).toBe("5.0.0");
  });

  test("refuses other bytes under a version the lock holds, and installs nothing", async () => {
    const versions = ["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"];
    const before = await readFile(lockPath(project), "utf8");
    await publish(versions, { rewrite: "6.0.0" });
    await withoutCopies();
    const install = await aireg(["install", "-y"]);
    expect(install.code).toBe(1);
    expect(install.stderr).toContain("may be tampering");
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
    await publish(versions);
  });

  test("keeps a yanked version the lock holds, and says it is yanked", async () => {
    await publish(["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"], {
      yank: "6.0.0",
    });
    await withoutCopies();
    const install = await aireg(["install", "-y"]);
    expect(install.code).toBe(0);
    expect(install.stderr).toContain("lint 6.0.0 is yanked (broken)");
    expect(await installed()).toContain("body 6.0.0");
    // Latest moved down to 5.0.0, which is older, not newer.
    const outdated = await aireg(["outdated"]);
    expect(outdated.stdout).not.toMatch(/^\s*lint\s/m);
    expect(JSON.parse((await aireg(["outdated", "--json"])).stdout).data.artifacts).toContainEqual(
      expect.objectContaining({ name: "lint", current: "6.0.0", latest: "5.0.0", moved: false }),
    );
  });

  test("installs only the files a version describes, and follows no link", async () => {
    const dir = join(market, "artifacts", "acme", "skill", "lint", "6.0.0");
    await writeFile(join(root, "secret"), "private key");
    await symlink(join(root, "secret"), join(dir, "leak.txt"));
    await writeFile(join(dir, "added.sh"), "undescribed");
    await withoutCopies();
    try {
      expect((await aireg(["install", "-y"])).code).toBe(0);
      expect(await readdir(join(project, ".claude", "skills", "lint"))).toEqual(["SKILL.md"]);
    } finally {
      await rm(join(dir, "leak.txt"));
      await rm(join(dir, "added.sh"));
    }
  });

  test("fails an install whose file does not match, and keeps the lock row", async () => {
    const versions = ["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"];
    const before = await readFile(lockPath(project), "utf8");
    await appendFile(join(market, "artifacts", "acme", "skill", "lint", "6.0.0", "SKILL.md"), "x");
    await withoutCopies();
    const install = await aireg(["install", "--json", "-y"]);
    expect(install.code).toBe(1);
    expect(JSON.parse(install.stdout)).toMatchObject({
      ok: false,
      error: { message: "Did not install lint.", adapter: "local" },
    });
    expect(install.stderr).toMatch(
      /Skipped lint: SKILL\.md arrived as \d+ bytes, but \d+ were described\./,
    );
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
    await publish(versions, { yank: "6.0.0" });
    expect((await aireg(["install", "-y"])).code).toBe(0);
  });

  test("keeps the installed version when the one update takes does not match", async () => {
    const versions = ["1.0.0", "1.1.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0", "7.0.0"];
    await publish(versions);
    await appendFile(join(market, "artifacts", "acme", "skill", "lint", "7.0.0", "SKILL.md"), "x");
    const update = await aireg(["update", "lint", "-y"]);
    expect(update.code).toBe(1);
    expect(update.stderr).toContain("Did not install lint.");
    expect(await lockedVersion()).toBe("6.0.0");
    expect(await installed()).toContain("body 6.0.0");
    await publish(versions);
  });

  test("refuses a lockfile with merge conflict markers, and leaves it alone", async () => {
    const conflicted = `<<<<<<< HEAD\n${await readFile(lockPath(project), "utf8")}`;
    await writeFile(lockPath(project), conflicted);
    for (const command of ["status", "install"]) {
      const result = await aireg([command, "-y"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("merge conflict");
    }
    expect(await readFile(lockPath(project), "utf8")).toBe(conflicted);
  });
});

describe("pinning back an artifact a whole namespace installed", () => {
  test("says it pinned the artifact and rolled it back", async () => {
    const whole = join(root, "whole");
    await mkdir(join(whole, ".claude"), { recursive: true });
    const at = { cwd: whole };
    expect((await aireg(["init", "-y"], at)).code).toBe(0);
    expect((await aireg(["registry", "add", market, "--as", "acme"], at)).code).toBe(0);
    expect((await aireg(["add", "acme/acme", "-y"], at)).code).toBe(0);

    const pinned = await aireg(["add", "acme/acme/skill/lint@1.0.0", "-y"], at);
    expect(pinned.code, pinned.stderr).toBe(0);
    expect(pinned.stdout).toContain("Pinned acme/lint at 1.0.0.");
    expect(pinned.stdout).toMatch(/Rolled back acme\/lint \d+\.0\.0 → 1\.0\.0\./);
    expect(pinned.stdout).not.toMatch(/Updated lint/);
  });
});
