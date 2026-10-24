import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { manifestPath } from "#test/kit/scope.ts";

/** A folder registry whose registry.json names it acme, beside the folders each test uses. */
const test = base.extend("acme", ({ tmp }) =>
  registry(join(tmp, "acme-registry"), { name: "acme", slug: "acme" })
    .skill("engineering/lint@1.0.0", { description: "Runs the linters." })
    .write(),
);

describe("aireg init --registry", () => {
  test("names the registry as registry add does", async ({ acme, aireg }) => {
    const app = join(dirname(acme), "app");
    await mkdir(app);
    const init = await aireg(["init", "--registry", "../acme-registry", "-y"], { cwd: app });
    expect(init.code).toBe(0);
    expect(await readFile(manifestPath(app), "utf8")).toContain("  acme: ../acme-registry\n");
  });

  test("prints one JSON document, and claims no step it did not take", async ({ acme, aireg }) => {
    const app = join(dirname(acme), "app");
    await mkdir(app);
    const json = await aireg(["init", "--registry", "../acme-registry", "--json"], { cwd: app });
    expect(json.code, json.stderr).toBe(0);
    const lines = json.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const { data } = JSON.parse(lines[0] as string);
    expect(data.next).toBeUndefined();
    expect(data.steps).toEqual([
      { name: "registry", detail: "acme → ../acme-registry" },
      { name: "pulled", detail: "1 artifact from acme" },
    ]);

    const other = join(dirname(acme), "other");
    await mkdir(other);
    const text = await aireg(["init", "--registry", "../acme-registry"], { cwd: other });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).not.toMatch(/next|published|pushed/);
  });

  test("leaves a skill it imported in the folder it came from, and status is clean", async ({
    acme,
    aireg,
  }) => {
    const app = join(dirname(acme), "app");
    const mine = join(app, ".claude", "skills", "release-notes");
    await mkdir(mine, { recursive: true });
    await writeFile(
      join(mine, "SKILL.md"),
      "---\nname: release-notes\ndescription: Drafts release notes.\n---\n\nDraft them.\n",
    );
    const flags = ["--import", "claude", "--registry", "../acme-registry"];
    const init = await aireg(["init", ...flags, "--publish-to", "acme/engineering", "-y"], {
      cwd: app,
    });
    expect(init.code).toBe(0);
    const status = await aireg(["status"], { cwd: app });
    expect(status.stdout + status.stderr).not.toContain("something of yours");
    expect(status.code).toBe(0);
  });
});

describe("aireg registry init through a linked artifacts folder", () => {
  const refused = "artifacts is a symlink, so nothing was written through it.";

  test("refuses to create a registry, and writes nothing", async ({ acme, aireg }) => {
    const outside = join(dirname(acme), "outside");
    const fresh = join(dirname(acme), "fresh");
    await mkdir(outside);
    await mkdir(fresh);
    await symlink(outside, join(fresh, "artifacts"));
    const init = ["registry", "init", "--name", "team", "--namespace", "eng", "-y"];
    const made = await aireg(init, { cwd: fresh });
    expect(made.code).toBe(1);
    expect(made.stderr).toContain(refused);
    expect(await readdir(outside)).toEqual([]);
    expect(existsSync(join(fresh, "registry.json"))).toBe(false);
  });

  test("refuses to add a namespace to a registry", async ({ acme, aireg }) => {
    const outside = join(dirname(acme), "outside");
    await mkdir(outside);
    await rm(join(acme, "artifacts"), { recursive: true });
    await symlink(outside, join(acme, "artifacts"));
    const added = await aireg(["registry", "init", "--namespace", "eng", "-y"], { cwd: acme });
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(refused);
    expect(await readdir(outside)).toEqual([]);
  });

  test("still adds a namespace to a registry with a real folder", async ({ acme, aireg }) => {
    const added = await aireg(["registry", "init", "--namespace", "eng", "-y"], { cwd: acme });
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(acme, "artifacts", "eng"))).toBe(true);
  });
});

describe("outside a project", () => {
  test("reads your user scope, and a command that writes there says so", async ({
    acme,
    aireg,
  }) => {
    const loose = join(dirname(acme), "loose");
    await mkdir(loose);
    const list = await aireg(["list"], { cwd: loose });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("your user scope");
    const added = await aireg(["registry", "add", "../acme-registry"], { cwd: loose });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("your user scope, since this folder is not a project");
  });

  test("publishes into a registry folder without naming your user scope", async ({
    acme,
    aireg,
  }) => {
    const loose = join(dirname(acme), "loose");
    await mkdir(join(loose, "triage"), { recursive: true });
    await writeFile(
      join(loose, "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Labels issues.\n---\n\nLabel them.\n",
    );
    const sent = await aireg(["publish", "triage", "--to", "../acme-registry/engineering", "-y"], {
      cwd: loose,
    });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).not.toContain("your user scope");
  });
});

describe("aireg registry validate on a pull request", () => {
  const injected = "x\n::warning title=INJECTED::fake annotation";

  // Windows refuses a folder name with a line break or a colon.
  test.skipIf(process.platform === "win32")(
    "cannot be made to print a workflow command by a folder's name",
    async ({ acme, aireg }) => {
      await mkdir(join(acme, "artifacts", "engineering", injected), { recursive: true });
      const run = await aireg(["registry", "validate"], {
        cwd: acme,
        env: { GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: acme },
      });
      expect(run.code).toBe(1);
      const commands = run.stdout.split("\n").filter((line) => line.startsWith("::"));
      expect(commands).toEqual([
        "::error file=artifacts/engineering/x%0A%3A%3Awarning title=INJECTED%3A%3Afake annotation,title=registry" +
          '::"x\\n::warning title=INJECTED::fake annotation" is not a kind.',
      ]);
      expect(run.stdout).toContain(
        '✗ "artifacts/engineering/x\\n::warning title=INJECTED::fake annotation"\n',
      );
    },
  );
});
