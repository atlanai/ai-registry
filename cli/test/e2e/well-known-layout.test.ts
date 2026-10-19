import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, test } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";
import { serveFolder, tarGz, wellKnownSite } from "#test/kit/site.ts";

const fill = tarGz([
  {
    path: "SKILL.md",
    body: "---\nname: fill\ndescription: Fill forms.\n---\nRun scripts/fill.sh.\n",
  },
  { path: "scripts/fill.sh", body: "#!/bin/sh\necho fill\n", mode: 0o755 },
]);

/** Runs `body` against `root` served on loopback, and stops serving it after. */
async function serving<T>(root: string, body: (url: string) => Promise<T>): Promise<T> {
  const site = await serveFolder(root);
  try {
    return await body(site.url);
  } finally {
    await site.close();
  }
}

const init = async (aireg: Aireg) =>
  expect((await aireg(["init", "--for", "claude"])).code).toBe(0);

describe("a site's Agent Skills index", () => {
  test("installs each skill it lists, a SKILL.md or an archive, once its digest checks out", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await wellKnownSite(join(tmp, "site"), [
      { name: "greet" },
      { name: "fill", type: "archive", archive: fill },
    ]);
    await init(aireg);
    await serving(root, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code, added.stderr).toBe(0);
    });
    const skills = join(project, ".claude", "skills");
    expect(existsSync(join(skills, "greet", "SKILL.md"))).toBe(true);
    expect(await readFile(join(skills, "fill", "scripts", "fill.sh"), "utf8")).toBe(
      "#!/bin/sh\necho fill\n",
    );
    expect(await readFile(manifestPath(project), "utf8")).toContain("layout: well-known");
    expect(await readFile(lockPath(project), "utf8")).toContain("adapter: well-known");
  }, 60_000);

  test("installs nothing from a site whose bytes do not match its digest", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await wellKnownSite(join(tmp, "site"), [
      { name: "greet" },
      { name: "fill", type: "archive", archive: fill, digest: `sha256:${"0".repeat(64)}` },
    ]);
    await init(aireg);
    await serving(root, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code).toBe(1);
      expect(added.stderr).toContain(
        `the sha256:${"0".repeat(64)} the index gives, so nothing was installed from it.`,
      );
    });
    expect(existsSync(join(project, ".claude", "skills", "greet"))).toBe(false);
  }, 60_000);

  test("refuses an index in another format, and the older one without digests", async ({
    aireg,
    tmp,
  }) => {
    const other = await wellKnownSite(
      join(tmp, "other"),
      [{ name: "greet" }],
      "https://example.test/9.json",
    );
    const legacy = join(tmp, "legacy");
    await mkdir(join(legacy, ".well-known", "skills"), { recursive: true });
    await writeFile(join(legacy, ".well-known", "skills", "index.json"), '{"skills":[]}');
    await init(aireg);
    await serving(other, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code).toBe(1);
      expect(added.stderr).toContain(
        'is an index in "https://example.test/9.json", and aireg reads only',
      );
    });
    await serving(legacy, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code).toBe(1);
      expect(added.stderr).toContain("index, which gives no digests, so aireg does not read it.");
    });
  }, 60_000);

  test("refuses an archive that reaches outside itself, and another host without https", async ({
    aireg,
    tmp,
  }) => {
    const escaping = await wellKnownSite(join(tmp, "escaping"), [
      { name: "fill", type: "archive", archive: tarGz([{ path: "../escape", body: "x" }]) },
    ]);
    const elsewhere = await wellKnownSite(join(tmp, "elsewhere"), [
      { name: "greet", url: "http://127.0.0.1:9/greet/SKILL.md" },
    ]);
    await init(aireg);
    await serving(escaping, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code).toBe(1);
      expect(added.stderr).toContain(
        `fill's archive holds "../escape", which is not a path inside it.`,
      );
    });
    await serving(elsewhere, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code).toBe(1);
      expect(added.stderr).toContain("which is another host without https.");
    });
  }, 60_000);

  test("points a site with no index at the git adapter, and refuses a version", async ({
    aireg,
    tmp,
  }) => {
    const empty = join(tmp, "empty");
    await mkdir(empty, { recursive: true });
    const root = await wellKnownSite(join(tmp, "site"), [{ name: "greet" }]);
    await init(aireg);
    await serving(empty, async (url) => {
      const added = await aireg(["add", url, "--all"]);
      expect(added.code).toBe(1);
      expect(added.stderr).toContain("has no Agent Skills index at");
      expect(added.stderr).toContain("If it is a git repository, add it with `--adapter git`.");
    });
    await serving(root, async (url) => {
      expect((await aireg(["registry", "add", url, "--as", "site"])).code).toBe(0);
      const pinned = await aireg(["add", "site/localhost/greet@1.0.0", "-y"]);
      expect(pinned.code).toBe(1);
      expect(pinned.stderr).toContain("site is a site's skills index, which has no versions");
    });
  }, 60_000);
});
