import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { acquire } from "#core/lease.ts";
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

  test("says what a plugin would have a harness start", async ({ aireg, tmp: root }) => {
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

  test("counts what it did, not what it planned, when a folder of yours is in the way", async ({
    aireg,
    tmp: root,
    kit,
  }) => {
    const own = join(root, "own");
    await mkdir(join(own, ".claude", "skills", "deploy"), { recursive: true });
    await writeFile(join(own, ".claude", "skills", "deploy", "SKILL.md"), "mine\n");
    await aireg(["init", "-y", "--for", "claude"], { cwd: own });
    await aireg(["registry", "add", kit, "--as", "kit"], { cwd: own });
    const added = await aireg(["add", "kit/kit/skill/deploy", "-y"], { cwd: own });
    expect(added.stdout).not.toMatch(/installed/i);

    expect((await aireg(["install"], { cwd: own })).stdout).toContain("Already up to date");
    const again = JSON.parse((await aireg(["install", "--json"], { cwd: own })).stdout).data;
    expect(again).toMatchObject({ changed: 0, installed: [] });
    expect(again.kept).toEqual([
      { name: "deploy", path: expect.stringMatching(/\.claude[\\/]skills[\\/]deploy$/) },
    ]);
  }, 30_000);

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

  test("keeps both of two settings written at once", async ({ aireg }) => {
    for (let round = 0; round < 2; round += 1) {
      const namespace = `kit/round-${round}`;
      const [paused, named] = await Promise.all([
        aireg(["config", "set", "paused", round % 2 === 0 ? "true" : "false"]),
        aireg(["config", "set", "defaults.namespace", namespace]),
      ]);
      expect([paused.code, named.code], paused.stderr + named.stderr).toEqual([0, 0]);
      expect((await aireg(["config", "get", "paused"])).stdout.trim()).toBe(
        String(round % 2 === 0),
      );
      expect((await aireg(["config", "get", "defaults.namespace"])).stdout.trim()).toBe(namespace);
    }
    expect((await aireg(["config", "set", "paused", "false"])).code).toBe(0);
  }, 120_000);

  test("reads and writes the default namespace", async ({ aireg }) => {
    expect((await aireg(["config", "set", "defaults.namespace", "kit/team"])).code).toBe(0);
    expect((await aireg(["config", "get", "defaults.namespace"])).stdout.trim()).toBe("kit/team");
    // An address that names no namespace is the guessing this setting prevents.
    const bad = await aireg(["config", "set", "defaults.namespace", "kit"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("takes <registry>/<namespace>");
    expect(bad.stderr).not.toContain("config.yml");
    // The grammar's other refusals are unit tested; this one checks the echo is escaped.
    const refused = await aireg(["config", "set", "defaults.namespace", "kit/te\u202Eam"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).not.toMatch(/\u202Eam/);
    expect((await aireg(["config", "get", "defaults.namespace"])).stdout.trim()).toBe("kit/team");
  }, 30_000);

  // --json must not reuse the text stringifier, or `paused` comes back as "false" and any
  // `if (data.paused)` is true.
  test("keeps paused a boolean, in --json and on the way in", async ({ aireg }) => {
    const set = await aireg(["config", "set", "paused", "false", "--json"]);
    expect(JSON.parse(set.stdout).data).toEqual({ key: "paused", value: false });
    const bad = await aireg(["config", "set", "paused", "yes"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('`paused` takes true or false, not "yes".');

    const listed = await aireg(["config", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).data.paused).toBe(false);
    const got = await aireg(["config", "get", "paused", "--json"]);
    expect(JSON.parse(got.stdout).data.value).toBe(false);
    // Still a bare word in text, so `$(aireg config get paused)` works.
    expect((await aireg(["config", "get", "paused"])).stdout.trim()).toBe("false");
  }, 30_000);

  test("answers for the daemon without starting it", async ({ aireg }) => {
    const status = await aireg(["daemon", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Not running");
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

  test("fails bare aireg with the same exit status in text and JSON", async ({ aireg }) => {
    const bare = await aireg([]);
    expect(bare.code).toBe(2);
    expect(bare.stdout.trimEnd().split("\n").at(-1)).toMatch(/^Run `aireg --help` for examples/);
    const json = await aireg(["--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: { code: "usage", message: "No command given." },
    });
  });

  // The --log-level rows check a global's value is never left behind as a positional and
  // taken as the subcommand.
  test("takes the global flags anywhere, and refuses bad combinations", async ({ aireg }) => {
    for (const argv of [
      ["harnesses", "--log-level", "debug"],
      ["--log-level", "debug", "harnesses"],
      ["harnesses", "--log-level=debug"],
      ["harnesses", "-q"],
      ["--quiet", "harnesses"],
      ["harnesses", "--no-color"],
      ["--color", "never", "harnesses"],
      ["harnesses", "--color=always"],
    ]) {
      const ran = await aireg(argv);
      expect(ran.code, argv.join(" ")).toBe(0);
      expect(ran.stdout, argv.join(" ")).toContain("claude");
    }
    for (const [argv, refusal] of [
      [["harnesses", "-q", "--verbose"], "--quiet and --verbose cannot be used together"],
      [["--no-color", "harnesses", "--color", "always"], "--color and --no-color cannot be"],
      [["harnesses", "--color", "blue"], '--color takes auto, always or never, not "blue"'],
      [["config", "path", "--log-level"], "--log-level needs a value."],
      [["harnesses", "--log-level", "loud"], "--log-level takes trace, debug, info, warn, error"],
    ] as const) {
      const ran = await aireg([...argv]);
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(ran.stderr, argv.join(" ")).toContain(refusal);
    }
  }, 30_000);

  // Globals read from the whole line would let `-m "-revert"` print the version and a
  // publish exit 0 without running.
  test("reads a flag only where it belongs, and runs nothing otherwise", async ({
    aireg,
    tmp: root,
  }) => {
    for (const argv of [
      ["--dry-run", "install"],
      ["-g", "list"],
      ["--for", "claude", "add", "kit"],
      ["--frozen"],
    ]) {
      const ran = await aireg(argv);
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(ran.stderr, argv.join(" ")).toContain(`${argv[0]} must come after the command name`);
    }
    const remove = await aireg(["-g", "remove", "lint", "-y"]);
    expect(remove.code).toBe(2);
    expect(remove.stderr).toContain("Did you mean `aireg remove -g lint -y`?");

    const verbose = await aireg(["remove", "lint", "-y", "-v"]);
    expect(verbose.code).toBe(2);
    expect(verbose.stderr).toContain("Did you mean `--verbose`?");
    expect((await aireg(["list"])).stdout).toContain("lint");

    const value = await aireg(["registry", "init", join(root, "dash"), "--description", "-h x"]);
    expect(value.code).toBe(2);
    expect(value.stderr).toContain('write `--description="-h x"`');
    expect(existsSync(join(root, "dash"))).toBe(false);

    expect((await aireg(["add", "-h", "-v"])).stdout).toContain("Usage: aireg add");
    expect((await aireg(["harnesses", "-yq"])).code).toBe(0);
  }, 30_000);

  // closest() is unit tested; these check it is wired to commands and to options.
  test("suggests the closest name and runs nothing", async ({ aireg }) => {
    const typo = await aireg(["instal"]);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("Did you mean `aireg install`?");
    expect((await aireg(["add", "--dryrun", "kit"])).stderr).toContain("Did you mean `--dry-run`?");
  }, 30_000);

  test("does not apply the Node.js floor to Bun's emulated version", async ({ aireg }) => {
    const hook =
      'Object.defineProperties(process.versions,{node:{value:"24.3.0"},bun:{value:"1.3.12"}})';
    const ran = await aireg(["--version"], { node: ["--import", `data:text/javascript,${hook}`] });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(ran.stderr).not.toContain("requires Node.js");
  });

  test.for([
    {
      failure: "an old Node.js",
      args: ["--version"],
      hook: 'Object.defineProperty(process.versions,"node",{value:"22.18.0"})',
      error: "error: aireg requires Node.js ^22.23.4 || ^24.22.1 || >=26.12.1; this is 22.18.0.",
    },
    {
      failure: "a failure before the command starts",
      args: ["--json", "status"],
      hook: 'process.cwd=()=>{throw new Error("ENOENT: no such file or directory, uv_cwd")}',
      error: "uv_cwd",
    },
    {
      failure: "a stray failure",
      args: ["--json", "status"],
      hook: 'const on=process.stdout.on;process.stdout.on=function(e,f){if(e==="error")setTimeout(()=>{throw new Error("stray")});return on.call(this,e,f)}',
      error: "stray",
    },
  ])("reports $failure without a stack trace", async ({ args, hook, error }, { aireg }) => {
    const ran = await aireg(args, { node: ["--import", `data:text/javascript,${hook}`] });
    expect(ran.code).toBe(1);
    if (args[0] === "--json") {
      expect(JSON.parse(ran.stdout)).toMatchObject({
        ok: false,
        error: { code: "error", message: expect.stringContaining(error) },
      });
    } else {
      expect(ran.stderr).toContain(error);
      if (args[0] === "--version") {
        expect(ran.stderr).toContain("Install a supported Node.js version");
        expect(ran.stderr).not.toContain("standalone");
      }
    }
    expect(ran.stderr).not.toMatch(/\n\s+at /);
  });

  // Usage and failure are different answers: a script can retry on one.
  test("exits 2 for a usage error and 1 for a real one", async ({ aireg }) => {
    for (const argv of [
      ["config", "get"],
      ["config", "frobnicate"],
      ["registry", "remove"],
      ["job", "runs", "list"],
      ["add"],
      ["add", "--bogus", "x"],
      ["status", "extra"],
      ["list", "lint", "extra"],
      ["unlock", "id", "extra"],
      ["logs", "--tail", "x"],
      ["console"],
      ["frobnicate"],
    ]) {
      expect((await aireg(argv)).code, argv.join(" ")).toBe(2);
    }
    // The command line was fine; what it names does not exist.
    expect((await aireg(["list", "nosuch"])).code).toBe(1);
  }, 60_000);

  test("prints the logs as one JSON document, each entry with its log", async ({ aireg }) => {
    expect((await aireg(["--log-level", "info", "list"])).code).toBe(0);
    const ran = await aireg(["logs", "--cli", "--json"]);
    expect(ran.code, ran.stderr).toBe(0);
    const { data } = JSON.parse(ran.stdout) as { data: { entries: { log: string }[] } };
    expect(data.entries.length).toBeGreaterThan(0);
    expect(new Set(data.entries.map((entry) => entry.log))).toEqual(new Set(["cli"]));
  });

  // As `tail -n 0`: nothing, and no claim that the log is empty.
  test("prints nothing for --tail 0 when there are entries", async ({ aireg }) => {
    expect((await aireg(["--log-level", "info", "list"])).code).toBe(0);
    const ran = await aireg(["logs", "--cli", "--tail", "0"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe("");
    const json = await aireg(["logs", "--cli", "--tail", "0", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, data: { entries: [] } });
  });

  test("refuses an option the command or action does not take", async ({ aireg }) => {
    for (const argv of [
      ["list", "--frozen"],
      ["doctor", "--for", "claude"],
      ["logs", "--dry-run"],
      ["daemon", "status", "--frozen"],
    ]) {
      const ran = await aireg(argv);
      const flag = argv.find((arg) => arg.startsWith("-"));
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(ran.stderr, argv.join(" ")).toContain(`Unknown option "${flag}".`);
      expect(ran.stderr, argv.join(" ")).toContain(`Run \`aireg ${argv[0]} --help\``);
    }
    const sibling = await aireg(["registry", "list", "--dry-run"]);
    expect(sibling.code).toBe(2);
    expect(sibling.stderr).toContain('`aireg registry list` does not take "--dry-run".');
    expect((await aireg(["job", "list", "-g"])).stderr).toContain(
      '`aireg job list` does not take "-g".',
    );
    expect((await aireg(["list", "-y"])).code).toBe(0);
  }, 30_000);

  test("prints a command's own help for --help, -h and aireg help", async ({ aireg }) => {
    const add = await aireg(["add", "--help"]);
    expect(add.code).toBe(0);
    expect((await aireg(["help", "add"])).stdout).toBe(add.stdout);
    expect((await aireg(["add", "-h"])).stdout).toBe(add.stdout);

    const action = await aireg(["registry", "add", "-h"]);
    expect(action.stdout).toContain("Usage: aireg registry add <address>");
    expect(action.stdout).not.toContain("--namespace");
    expect(JSON.parse((await aireg(["help", "registry", "add", "--json"])).stdout).data.path).toBe(
      "aireg registry add",
    );

    const unknown = await aireg(["help", "registry", "nosuch"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown registry action "nosuch"');
    expect((await aireg(["nosuch", "--help"])).code).toBe(2);
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

  // `sync` dispatches before parsing strictly: the common options know nothing of --mine,
  // so `resolve` could not otherwise run.
  test("reaches sync resolve, whose flags the sync parser does not know", async ({ aireg }) => {
    for (const argv of [
      ["sync", "resolve", "job_x", "lint", "--mine"],
      ["resolve", "job_x", "lint", "--theirs"],
    ]) {
      const ran = await aireg(argv);
      expect(ran.stderr + ran.stdout, argv.join(" ")).not.toContain("Unknown option");
    }
    // It got far enough to enforce its own rule rather than die in the parser.
    const neither = await aireg(["sync", "resolve", "job_x", "lint"]);
    expect(neither.stderr).toContain("needs exactly one of --mine or --theirs");
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
    }, 60_000);

    // A foreground run goes through the run store, so it leaves history and `sync resolve`
    // can name what it found.
    test("records the run, so the daemon can show it", async ({ aireg }) => {
      await aireg(["sync"]);
      const listed = await aireg(["job", "runs"]);
      expect(listed.code).toBe(0);
      // A sync started by hand belongs to no job; its trigger says who started it.
      expect(listed.stdout).toMatch(/run_[0-9a-f-]{36}\s+\w+\s+sync\s+-\s+manual/);
      await aireg(["daemon", "stop"]);
    }, 60_000);
  });
});
