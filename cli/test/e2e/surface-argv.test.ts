import { describe, expect } from "vitest";
import { fileTest as test } from "#test/kit/fixtures.ts";

// Each case here is refused, or only reads, so the rows of one test run at once.
describe("the command line", () => {
  test("fails bare aireg with the same exit status in text and JSON", async ({ aireg }) => {
    const [bare, json] = await Promise.all([aireg([]), aireg(["--json"])]);
    expect(bare.code).toBe(2);
    expect(bare.stdout.trimEnd().split("\n").at(-1)).toMatch(/^Run `aireg --help` for examples/);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: { code: "usage", message: "No command given." },
    });
  });

  // The --log-level rows check a global's value is never left behind as a positional and
  // taken as the subcommand.
  test("takes the global flags anywhere, and refuses bad combinations", async ({ aireg }) => {
    const taken = [
      ["targets", "--log-level", "debug"],
      ["--log-level", "debug", "targets"],
      ["targets", "--log-level=debug"],
      ["targets", "-q"],
      ["--quiet", "targets"],
      ["targets", "--no-color"],
      ["--color", "never", "targets"],
      ["targets", "--color=always"],
    ];
    const refused = [
      [["targets", "-q", "--verbose"], "--quiet and --verbose cannot be used together"],
      [["--no-color", "targets", "--color", "always"], "--color and --no-color cannot be"],
      [["targets", "--color", "blue"], '--color takes auto, always or never, not "blue"'],
      [["config", "path", "--log-level"], "--log-level needs a value."],
      [["targets", "--log-level", "loud"], "--log-level takes trace, debug, info, warn, error"],
    ] as const;
    const [ran, refusals] = await Promise.all([
      Promise.all(taken.map((argv) => aireg(argv))),
      Promise.all(refused.map(([argv]) => aireg([...argv]))),
    ]);
    for (const [at, argv] of taken.entries()) {
      expect(ran[at]?.code, argv.join(" ")).toBe(0);
      expect(ran[at]?.stdout, argv.join(" ")).toContain("claude-code");
    }
    for (const [at, [argv, refusal]] of refused.entries()) {
      expect(refusals[at]?.code, argv.join(" ")).toBe(2);
      expect(refusals[at]?.stderr, argv.join(" ")).toContain(refusal);
    }
  });

  // closest() is unit tested; these check it is wired to commands and to options.
  test("suggests the closest name and runs nothing", async ({ aireg }) => {
    const [typo, option] = await Promise.all([
      aireg(["instal"]),
      aireg(["add", "--dryrun", "kit"]),
    ]);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("Did you mean `aireg install`?");
    expect(option.stderr).toContain("Did you mean `--dry-run`?");
  });

  // Usage and failure are different answers: a script can retry on one.
  test("exits 2 for a usage error and 1 for a real one", async ({ aireg }) => {
    const usage = [
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
    ];
    const [ran, missing] = await Promise.all([
      Promise.all(usage.map((argv) => aireg(argv))),
      aireg(["list", "nosuch"]),
    ]);
    for (const [at, argv] of usage.entries()) expect(ran[at]?.code, argv.join(" ")).toBe(2);
    // The command line was fine; what it names does not exist.
    expect(missing.code).toBe(1);
  });

  test("refuses an option the command or action does not take", async ({ aireg }) => {
    const unknown = [
      ["list", "--frozen"],
      ["doctor", "--for", "claude-code"],
      ["logs", "--dry-run"],
      ["daemon", "status", "--frozen"],
    ];
    const [ran, sibling, job, yes] = await Promise.all([
      Promise.all(unknown.map((argv) => aireg(argv))),
      aireg(["registry", "list", "--dry-run"]),
      aireg(["job", "list", "-g"]),
      aireg(["list", "-y"]),
    ]);
    for (const [at, argv] of unknown.entries()) {
      const flag = argv.find((arg) => arg.startsWith("-"));
      expect(ran[at]?.code, argv.join(" ")).toBe(2);
      expect(ran[at]?.stderr, argv.join(" ")).toContain(`Unknown option "${flag}".`);
      expect(ran[at]?.stderr, argv.join(" ")).toContain(`Run \`aireg ${argv[0]} --help\``);
    }
    expect(sibling.code).toBe(2);
    expect(sibling.stderr).toContain('`aireg registry list` does not take "--dry-run".');
    expect(job.stderr).toContain('`aireg job list` does not take "-g".');
    expect(yes.code).toBe(0);
  });

  test("prints a command's own help for --help, -h and aireg help", async ({ aireg }) => {
    const [add, help, short, action, json, unknown, nosuch] = await Promise.all([
      aireg(["add", "--help"]),
      aireg(["help", "add"]),
      aireg(["add", "-h"]),
      aireg(["registry", "add", "-h"]),
      aireg(["help", "registry", "add", "--json"]),
      aireg(["help", "registry", "nosuch"]),
      aireg(["nosuch", "--help"]),
    ]);
    expect(add.code).toBe(0);
    expect(help.stdout).toBe(add.stdout);
    expect(short.stdout).toBe(add.stdout);
    expect(action.stdout).toContain("Usage: aireg registry add <address>");
    expect(action.stdout).not.toContain("--namespace");
    expect(JSON.parse(json.stdout).data.path).toBe("aireg registry add");
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown registry action "nosuch"');
    expect(nosuch.code).toBe(2);
  });

  // `sync` dispatches before parsing strictly: the common options know nothing of --mine,
  // so `resolve` could not otherwise run.
  test("reaches sync resolve, whose flags the sync parser does not know", async ({ aireg }) => {
    const reached = [
      ["sync", "resolve", "job_x", "lint", "--mine"],
      ["resolve", "job_x", "lint", "--theirs"],
    ];
    const [ran, neither] = await Promise.all([
      Promise.all(reached.map((argv) => aireg(argv))),
      aireg(["sync", "resolve", "job_x", "lint"]),
    ]);
    for (const [at, argv] of reached.entries()) {
      expect(`${ran[at]?.stderr}${ran[at]?.stdout}`, argv.join(" ")).not.toContain(
        "Unknown option",
      );
    }
    // It got far enough to enforce its own rule rather than die in the parser.
    expect(neither.stderr).toContain("needs exactly one of --mine or --theirs");
  });
});

describe("starting up", () => {
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
});
