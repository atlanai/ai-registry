import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { acquire } from "#core/lease/lease.ts";
import { roots } from "#core/store/paths.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { fileTest } from "#test/kit/fixtures.ts";

const ACME = fileURLToPath(new URL("../../../examples/acme-registry", import.meta.url));

const test = fileTest.extend("kit", { scope: "file" }, ({ tmp }) =>
  registry(join(tmp, "kit"))
    .skill("kit/lint@1.0.0", { description: "Lint it." })
    .skill("kit/deploy@1.0.0", { description: "Ship it." })
    .write(),
);

test.beforeAll(async ({ aireg, project, kit }) => {
  await mkdir(join(project, ".claude"), { recursive: true });
  await aireg(["init", "-y"]);
  // Declaring and installing from the alias are covered by test/scenarios.
  expect((await aireg(["registry", "add", kit, "--as", "kit"])).code).toBe(0);
  expect((await aireg(["add", "kit", "--all", "-y"])).code).toBe(0);
}, 120_000);

describe("the command surface", () => {
  test("prints a file without the terminal escapes in it", async ({ aireg, tmp: root }) => {
    const dir = join(root, "escapes");
    await mkdir(dir);
    await writeFile(
      join(dir, "SKILL.md"),
      "keep\tthis\n\u001b[2Jgone\u001b]52;c;eA==\u0007 x\rhidden\n",
    );
    const shown = await aireg(["show", "./escapes"], { cwd: root });
    expect(shown.stdout).toBe("keep\tthis\ngone xhidden\n");
    expect(shown.stderr).toContain("Removed terminal control characters");
  });

  test("says what a plugin would have a target start", async ({ aireg, tmp: root }) => {
    const dir = join(root, "tools");
    await mkdir(join(dir, "hooks"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# tools\n");
    await writeFile(join(dir, "hooks", "hooks.json"), '{"hooks":{}}');
    await writeFile(join(dir, ".mcp.json"), '{"mcpServers":{}}');
    const shown = await aireg(["show", "./tools"], { cwd: root });
    expect(shown.stdout).toBe("# tools\n");
    expect(shown.stderr).toContain("tools carries hooks and MCP servers");
    const json = await aireg(["show", "./tools", "--json"], { cwd: root });
    expect(JSON.parse(json.stdout).data.carries).toEqual(["hooks", "mcpServers"]);
  });

  test("reports nothing to do on an up-to-date tree", async ({ aireg }) => {
    const updated = await aireg(["update"]);
    expect(updated.code).toBe(0);
    expect(updated.stdout).toContain("up to date");
  });

  test("refuses to drop a registry something still needs", async ({ aireg }) => {
    const removed = await aireg(["registry", "remove", "kit"]);
    expect(removed.code).not.toBe(0);
    expect(removed.stderr + removed.stdout).toMatch(/still provides/);
  });

  test("reports the writer lease, with the same exit status in text and JSON", async ({
    aireg,
    home: { dir: home },
    project,
  }) => {
    const unlocked = await aireg(["unlock"]);
    expect(unlocked.code).toBe(0);
    expect(unlocked.stdout).toMatch(/Nothing is writing to this project/);
    // An id names one lock; with none held, it matches nothing.
    const stale = await aireg(["unlock", "5b1c9f0e-1111-4111-8111-111111111111"]);
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain('No lock with id "5b1c9f0e-1111-4111-8111-111111111111"');
    expect(stale.stderr).toContain("nothing is writing to this project");

    const env = { ...process.env, AIREG_HOME: join(home, ".aireg") };
    const lease = await acquire(roots("project", project, env), { env });
    try {
      const shown = await aireg(["unlock"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toMatch(/started writing to this project/);
      expect(shown.stderr).toContain(`aireg unlock ${lease.id}`);
      expect((await aireg(["unlock", "--json"])).code).toBe(0);
    } finally {
      await lease.release();
    }
  });

  // Globals read from the whole line would let `-m "-revert"` print the version and a
  // publish exit 0 without running.
  test("reads a flag only where it belongs, and runs nothing otherwise", async ({
    aireg,
    tmp: root,
  }) => {
    const misplaced = [
      ["--dry-run", "install"],
      ["-g", "list"],
      ["--for", "claude", "add", "kit"],
      ["--frozen"],
    ];
    // Each is refused or only reads, so they run at once.
    const [ran, remove, verbose, value, help, combined] = await Promise.all([
      Promise.all(misplaced.map((argv) => aireg(argv))),
      aireg(["-g", "remove", "lint", "-y"]),
      aireg(["remove", "lint", "-y", "-v"]),
      aireg(["registry", "init", join(root, "dash"), "--description", "-h x"]),
      aireg(["add", "-h", "-v"]),
      aireg(["targets", "-yq"]),
    ]);
    for (const [at, argv] of misplaced.entries()) {
      expect(ran[at]?.code, argv.join(" ")).toBe(2);
      expect(ran[at]?.stderr, argv.join(" ")).toContain(
        `${argv[0]} must come after the command name`,
      );
    }
    expect(remove.code).toBe(2);
    expect(remove.stderr).toContain("Did you mean `aireg remove -g lint -y`?");
    expect(verbose.code).toBe(2);
    expect(verbose.stderr).toContain("Did you mean `--verbose`?");
    expect((await aireg(["list"])).stdout).toContain("lint");

    expect(value.code).toBe(2);
    expect(value.stderr).toContain('write `--description="-h x"`');
    expect(existsSync(join(root, "dash"))).toBe(false);

    expect(help.stdout).toContain("Usage: aireg add");
    expect(combined.code).toBe(0);
  }, 30_000);

  test("warns when a built-in command hides a registry kind", async ({ aireg, tmp: root }) => {
    const dir = join(root, "shadowed");
    await cp(ACME, dir, { recursive: true });
    const file = join(dir, "registry.json");
    const json = JSON.parse(await readFile(file, "utf8"));
    json.kinds.push({ name: "status", manifest_url: "kinds/skill.json" });
    await writeFile(file, JSON.stringify(json));

    const help = await aireg(["--help"], { cwd: dir });
    expect(help.stderr).toContain('The kind "status" has the same name as a command');
    expect(help.stdout).not.toMatch(/^ {2}status\s+Create/m);
    const validate = await aireg(["registry", "validate", "--json"], { cwd: dir });
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout).data.warnings).toHaveLength(1);
    expect((await aireg(["status", "new", "x"], { cwd: dir })).stderr).toContain(
      'The kind "status"',
    );
  }, 30_000);

  test("points a kind it left out at the manifest that left it out", async ({
    aireg,
    tmp: root,
  }) => {
    const dir = join(root, "left-out");
    await cp(ACME, dir, { recursive: true });
    const file = join(dir, "registry.json");
    const json = JSON.parse(await readFile(file, "utf8"));
    json.kinds.push({ name: "prompt", manifest_url: "kinds/prompt.json" });
    await writeFile(file, JSON.stringify(json));
    const manifest = JSON.parse(await readFile(join(dir, "kinds", "skill.json"), "utf8"));
    manifest.properties.name.pattern = "^(?!draft-)[a-z-]+$";
    await writeFile(join(dir, "kinds", "prompt.json"), JSON.stringify(manifest));

    const created = await aireg(["prompt", "new", "x"], { cwd: dir });
    expect(created.stderr).toContain(
      'The kind "prompt" is left out: kinds/prompt.json has an invalid kind schema',
    );
  }, 30_000);

  describe("sync reconciles", () => {
    test("reports without writing under --dry-run, and writes without it", async ({
      aireg,
      project,
      kit,
    }) => {
      await aireg(["add", "kit", "--all", "-y"]);
      // A version directory is written once, so upstream moving is a new
      // version rather than an edit to the one already published.
      await registry(kit)
        .skill("kit/lint@1.0.0", { description: "Lint it." })
        .skill("kit/deploy@1.1.0", {
          description: "Ship it.",
          body: "\n# deploy\n\nUpstream moved.\n",
        })
        .write();

      const preview = await aireg(["sync", "--dry-run"]);
      expect(preview.code).toBe(3);
      expect(preview.stdout).toContain("deploy");
      // A preview that wrote would make the next assertion pass for the wrong reason.
      const copy = join(project, ".registry", "artifacts", "kit", "kit", "skills", "deploy");
      expect(await readFile(join(copy, "SKILL.md"), "utf8")).not.toContain("Upstream moved.");

      const ran = await aireg(["sync"]);
      expect(ran.code).toBe(0);
      expect(await readFile(join(copy, "SKILL.md"), "utf8")).toContain("Upstream moved.");
    });

    // A foreground run goes through the run store, so it leaves history and `sync resolve`
    // can name what it found.
    test("records the run, so the daemon can show it", async ({ aireg }) => {
      await aireg(["sync"]);
      const listed = await aireg(["job", "runs"]);
      expect(listed.code).toBe(0);
      // A sync started by hand belongs to no job; its trigger says who started it.
      expect(listed.stdout).toMatch(/run_[0-9a-f-]{36}\s+\w+\s+sync\s+-\s+manual/);
      await aireg(["daemon", "stop"]);
    });
  });
});
