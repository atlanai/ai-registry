import { existsSync, readdirSync } from "node:fs";
import { appendFile, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, type Git, fileTest as test } from "#test/kit/fixtures.ts";

let aireg: Aireg;
let git: Git;
let root: string;
let market: string;
let project: string;
let outside: string;
let home: string;

/** Republishes the whole root, which is how a registry gains artifacts and versions. */
async function publish(artifacts: Record<string, string[]>): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" });
  for (const [path, versions] of Object.entries(artifacts)) {
    const name = path.split("/")[1];
    for (const version of versions)
      built.skill(`${path}@${version}`, { body: `${name} ${version}\n` });
  }
  await built.write();
}

const read = (path: string) => readFile(join(project, path), "utf8");

test.beforeAll(async ({ aireg: run, git: gitIn, tmp, project: dir, home: { dir: homeDir } }) => {
  [aireg, git, root, project, home] = [run, gitIn, tmp, dir, homeDir];
  market = join(root, "market");
  outside = join(root, "outside");
  await Promise.all([mkdir(join(project, "src"), { recursive: true }), mkdir(outside)]);
  await git.init(project);
  await publish({
    "platform/lint": ["1.0.0", "1.1.0"],
    "data/profile": ["0.4.0"],
    // More than the cap of 10, so a namespace address has to count only its own.
    ...Object.fromEntries(Array.from({ length: 11 }, (_, at) => [`data/report-${at}`, ["0.1.0"]])),
  });
}, 60_000);

describe("consuming a registry like a package manager", () => {
  test("declares a registry for the user from outside any project", async () => {
    expect((await aireg(["registry", "add", market, "--as", "acme"], { cwd: outside })).code).toBe(
      0,
    );
    expect(await readFile(join(home, ".registry", "manifest.yml"), "utf8")).toContain("acme:");
  });

  test("counts only the namespace an address names against the cap", async () => {
    const data = await aireg(["add", "acme/data", "-y", "--dry-run"], { cwd: outside });
    expect(data.code).toBe(2);
    expect(data.stderr).toMatch(/Installing 12 artifacts needs confirmation/);
    const elsewhere = await aireg(["add", "acme/platform", "-s", "profile", "--dry-run"], {
      cwd: outside,
    });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.stderr).toMatch(/publishes nothing named "profile"/);
  });

  test("refuses a namespace, and shows one artifact from a registry it has not declared", async () => {
    const shown = await aireg(["show", "acme/data"], { cwd: outside });
    expect(shown.code).toBe(2);
    expect(shown.stderr).toContain("aireg registry show acme");
    const undeclared = await aireg(["show", "data/profile", "--registry", market], {
      cwd: outside,
    });
    expect(undeclared.stdout).toContain("name: profile");
  });

  test("takes the user scope outside a project, as registry add does", async () => {
    const planned = await aireg(["add", "acme/platform", "-y", "--dry-run"], { cwd: outside });
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stdout).toContain("your user scope");
  });

  test("installs into the repository around it, recording the user's alias there", async () => {
    const added = await aireg(["add", "acme/platform", "-y"], { cwd: join(project, "src") });
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, "src", ".registry"))).toBe(false);
    expect(await read(".registry/manifest.yml")).toContain(`acme: ${market}`);
    // Harnesses look one level deep, so a namespaced skill is linked flat.
    expect((await lstat(join(project, ".claude", "skills", "lint"))).isSymbolicLink()).toBe(true);
  });

  test("holds a pin written beside a whole namespace, in one row", async () => {
    expect((await aireg(["add", "acme/platform/skill/lint@1.0.0", "-y"])).code).toBe(0);
    const listed = await aireg(["list"]);
    expect(listed.stdout).toMatch(/ lint\s+skill\s+1\.0\.0 pinned\s+acme/);
    expect(listed.stdout.match(/lint/g)).toHaveLength(1);
  });

  test("reports what was published since, and a pin as held", async () => {
    await publish({
      "platform/lint": ["1.0.0", "1.1.0", "1.2.0"],
      "platform/changelog": ["0.1.0"],
      "data/profile": ["0.4.0"],
    });
    const outdated = await aireg(["outdated"]);
    expect(outdated.stdout).toMatch(/ changelog\s+acme\s+new\s+0\.1\.0/);
    expect(outdated.stdout).toMatch(/ lint\s+acme\s+1\.0\.0 pinned\s+1\.2\.0/);
  });

  test("takes what the namespace gained, and leaves the pin", async () => {
    expect((await aireg(["update", "-y"])).code).toBe(0);
    const listed = await aireg(["list"]);
    expect(listed.stdout).toMatch(/ changelog\s+skill/);
    expect(listed.stdout).toMatch(/ lint\s+skill\s+1\.0\.0 pinned\s+acme/);
  });

  test("moves the registry to an address that serves what is installed, and to no other", async () => {
    const mirror = join(root, "mirror");
    await cp(market, mirror, { recursive: true });
    const edited = join(root, "edited");
    await registry(edited, { name: "acme", slug: "acme" })
      .skill("platform/lint@1.0.0", { body: "lint, edited\n" })
      .write();
    const refused = await aireg(["registry", "add", edited, "--as", "acme"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "it has no acme/platform/skill/changelog@0.1.0, and it serves acme/platform/skill/lint@1.0.0 with other content.",
    );
    const planned = await aireg(["registry", "add", mirror, "--as", "acme", "--dry-run"]);
    expect(planned.stdout).toContain(`Would move registry acme from ${market} to ${mirror}`);
    expect(await read(".registry/manifest.yml")).toContain(`acme: ${market}`);

    const moved = await aireg(["registry", "add", mirror, "--as", "acme"]);
    expect(moved.code, moved.stderr).toBe(0);
    expect(await read(".registry/manifest.lock.yml")).toContain(`source: ${mirror}`);
    const installed = await aireg(["install"]);
    expect(`${installed.stdout}${installed.stderr}`).toContain("Already up to date");
    expect((await aireg(["list"])).stdout).toMatch(/ lint\s+skill\s+1\.0\.0 pinned\s+acme/);
    // Back where the rest of this suite publishes.
    expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
    for (const respelling of [`${market}/`, `${market}/../${basename(market)}`]) {
      const respelled = await aireg(["registry", "add", respelling, "--as", "acme"]);
      expect(respelled.code, respelled.stderr).toBe(0);
      expect(respelled.stdout).not.toContain("Moved");
    }
    expect((await aireg(["install", "--frozen"])).code).toBe(0);
  });

  test("reports an edit to an installed skill, and publishes it only when the run opts in", async () => {
    await appendFile(
      join(project, ".claude", "skills", "changelog", "SKILL.md"),
      "Group by label.\n",
    );
    const versions = () =>
      readFile(
        join(market, "artifacts", "platform", "skill", "changelog", "versions.json"),
        "utf8",
      );

    expect((await aireg(["sync"])).code).toBe(3);
    expect(await versions()).not.toContain("0.1.1");

    const sent = await aireg(["sync", "--publish", "on"]);
    expect(sent.code, sent.stderr).toBe(0);
    expect(await versions()).toContain("0.1.1");
  }, 60_000);

  test("removes by the address it was added with", async () => {
    const removed = await aireg(["remove", "acme/platform/skill/lint", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    const manifest = await read(".registry/manifest.yml");
    expect(manifest).not.toContain("acme/platform/skill/lint");
    // The namespace keeps taking what it publishes, minus what was removed.
    expect(manifest).toMatch(/exclude:\n\s+- skill\/lint/);
    const listed = (await aireg(["list"])).stdout;
    expect(listed).not.toContain("lint");
    expect(listed).toContain("changelog");
    // A newer lint is published, but the namespace leaves it out, so it isn't an update.
    expect((await aireg(["outdated"])).stdout).not.toMatch(/ lint\s/);
  });

  test("installs nothing published since when removing a namespace's last artifact", async () => {
    await publish({
      "platform/lint": ["1.0.0", "1.1.0", "1.2.0"],
      "platform/changelog": ["0.1.0", "0.1.1"],
      "platform/triage": ["0.1.0"],
      "data/profile": ["0.4.0"],
    });
    const planned = await aireg(["remove", "changelog", "--dry-run"]);
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stdout).not.toContain("triage");
    const removed = await aireg(["remove", "changelog", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(`${removed.stdout}${removed.stderr}`).not.toContain("triage");
    expect(existsSync(join(project, ".claude", "skills", "triage"))).toBe(false);
    expect((await aireg(["update", "--dry-run"])).stdout).toContain("triage");
  });

  test("removes a namespace by its address once none of its artifacts is installed", async () => {
    // The entry installs nothing, so the refusal names it rather than counting artifacts.
    const refused = await aireg(["registry", "remove", "acme"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("The manifest still takes acme/platform from registry acme.");
    const removed = await aireg(["remove", "acme/platform", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(await read(".registry/manifest.yml")).not.toContain("acme/platform");
    expect((await aireg(["update", "--dry-run"])).stdout).not.toContain("triage");
  });
});

describe("a copy the harness owns", () => {
  const copied = () => join(root, "copied");
  const run = (args: string[]) => aireg(args, { cwd: copied() });
  const harnessCopy = async (): Promise<string> => {
    const root = join(copied(), ".claude");
    const found = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => basename(path) === "SKILL.md" && path.includes("lint"))
      .map((path) => join(root, path))[0];
    if (found === undefined || found === "") throw new Error("no copied SKILL.md");
    return found;
  };

  beforeAll(async () => {
    await mkdir(copied(), { recursive: true });
    await git.init(copied());
    expect((await run(["init", "-y", "--for", "claude"])).code).toBe(0);
    expect((await run(["registry", "add", market, "--as", "acme"])).code).toBe(0);
    const added = await run(["add", "acme/platform/skill/lint@1.0.0", "--copy", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect((await lstat(await harnessCopy())).isSymbolicLink()).toBe(false);
  }, 60_000);

  test("sees an edit to the copy, and keeps it through an update", async () => {
    await appendFile(await harnessCopy(), "My own note.\n");
    const seen = await run(["status"]);
    expect(seen.code).toBe(3);
    expect(seen.stdout).toMatch(/copy was edited after installation/);
    const moved = await run(["add", "acme/platform/skill/lint", "-y"]);
    expect(moved.stderr).toMatch(
      /was edited after installation in \.claude\/skills\/lint, so it was left as it is/,
    );
    expect(await readFile(await harnessCopy(), "utf8")).toContain("My own note.");
  });

  test("keeps an edited copy on remove, and deletes it with --force", async () => {
    const kept = await run(["remove", "lint", "-y"]);
    expect(kept.code).toBe(3);
    expect(kept.stderr).toMatch(/lint has local edits, so nothing was removed\./);
    expect(await readFile(await harnessCopy(), "utf8")).toContain("My own note.");
    const forced = await run(["remove", "lint", "-y", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    await expect(harnessCopy()).rejects.toThrow();
  });
});

describe("a folder of yours where a link would go", () => {
  const blocked = () => join(root, "blocked");
  const run = (args: string[]) => aireg(args, { cwd: blocked() });

  beforeAll(async () => {
    await mkdir(join(blocked(), ".claude", "skills", "lint"), { recursive: true });
    await writeFile(join(blocked(), ".claude", "skills", "lint", "SKILL.md"), "mine\n");
    await git.init(blocked());
    expect((await run(["init", "-y", "--for", "claude"])).code).toBe(0);
    expect((await run(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  }, 60_000);

  test("is named by a dry run as a path it will skip", async () => {
    const planned = await run(["add", "acme/platform/skill/lint", "-y", "--dry-run"]);
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stderr).toMatch(
      /Would not install lint, because \.claude\/skills\/lint already holds something of yours\./,
    );
  });

  test("is left alone, and status says the link is missing until it moves", async () => {
    const added = await run(["add", "acme/platform/skill/lint", "-y"]);
    expect(added.stderr).toMatch(/already holds something of yours/);
    const seen = await run(["status"]);
    expect(seen.code).toBe(3);
    expect(seen.stdout).toMatch(/missing +something of yours is at \.claude\/skills\/lint/);
    const json = JSON.parse((await run(["status", "--json"])).stdout);
    expect(json.data.artifacts[0].detail).toBe(
      "claude: something of yours is at .claude/skills/lint",
    );
    expect(await readFile(join(blocked(), ".claude", "skills", "lint", "SKILL.md"), "utf8")).toBe(
      "mine\n",
    );

    await rm(join(blocked(), ".claude", "skills", "lint"), { recursive: true });
    expect((await run(["install"])).code).toBe(0);
    expect((await run(["status"])).code).toBe(0);
  });
});
