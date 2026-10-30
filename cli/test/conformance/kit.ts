import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { onPath } from "#adapter/paths.ts";
import { resolveTargets } from "#core/target/index.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { homeEnv } from "#test/kit/home.ts";
import { runCli } from "#test/kit/run.ts";
import { testRoot } from "#test/kit/temp.ts";

/** One command of the coding agent's own that lists what it loaded, and what its output holds. */
export interface Probe {
  /** Run from the project for `project`, from the home folder for `user`. */
  scope: "project" | "user";
  argv: string[];
  /** Written to the command's input, which is then closed, for a target that takes requests there. */
  stdin?: string;
  expect: (string | RegExp)[];
}

/** What a conformance test knows about one target, each part as its EVIDENCE.md records it. */
export interface Conformance {
  id: string;
  /** Variables the target reads to find its folders, each pointed into the sandbox's home. */
  env?: (home: string) => Record<string, string>;
  /** A target file to define it with, for one that is not built in. */
  file?: unknown;
  /** L2: runs only with AIREG_CONFORMANCE=1 and `argv[0]` on PATH. */
  probes?: Probe[];
}

/** One install of the fixtures: a folder registry, and an adapter whose namespace is a plugin. */
interface Sandbox {
  home: string;
  project: string;
  env: Record<string, string>;
  aireg: (args: readonly string[], cwd?: string) => ReturnType<typeof runCli>;
}

const AGENT = "---\nname: reviewer\ndescription: Reviews a change.\n---\n\nReview the diff.\n";
const PLANNER = "---\nname: planner\ndescription: Plans a change.\n---\n\nPlan the work.\n";
const SHIP = "---\nname: ship\ndescription: Ships a change.\n---\n\nShip it.\n";

/** Folders aireg keeps for itself, which no target reads. */
const OWN = [".aireg", ".registry", ".run", "fixtures", join("project", ".registry")];

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** An adapter serving the namespace `kit`, which a target that takes plugins loads as one. */
function pluginAdapter(): string {
  const artifact = (kind: string, name: string, body: string) => ({
    id: `${kind}_${name}`,
    kind,
    group: "kit",
    envelope: {
      apiVersion: "aireg.sh/v1",
      kind,
      metadata: { name, namespace: "kit", version: "1.0.0", description: `${name}.` },
      files: [
        {
          path: kind === "skill" ? "SKILL.md" : "AGENT.md",
          digest: `sha256:${digest(body)}`,
          size: Buffer.byteLength(body),
          media_type: "text/markdown",
          urls: [name],
        },
      ],
    },
    files: [{ path: kind === "skill" ? "SKILL.md" : "AGENT.md", locator: name, executable: false }],
  });
  const artifacts = [artifact("skill", "ship", SHIP), artifact("agent", "planner", PLANNER)];
  const bodies = { ship: SHIP, planner: PLANNER };
  return [
    "export default {",
    "  id: 'kit', displayName: 'kit', protocol: 1, artifactKinds: ['skill', 'agent'],",
    "  dispatch: { hosts: ['kit.example'] },",
    "  capabilities: { pinsSource: false, namespacePlugins: true },",
    "  connect: async () => ({",
    `    resolve: async () => ({ artifacts: ${JSON.stringify(artifacts)} }),`,
    `    fetch: async (_artifact, file) => new TextEncoder().encode(${JSON.stringify(bodies)}[file.locator]),`,
    "    close: async () => {},",
    "  }),",
    "};",
    "",
  ].join("\n");
}

async function sandbox(spec: Conformance): Promise<Sandbox> {
  const home = await realpath(await mkdtemp(join(testRoot(), `conformance-${spec.id}-`)));
  const project = join(home, "project");
  const fixtures = join(home, "fixtures");
  const env = { ...homeEnv(home), ...spec.env?.(home) };
  await mkdir(project, { recursive: true });
  await mkdir(env.XDG_RUNTIME_DIR as string, { recursive: true, mode: 0o700 });
  await mkdir(join(env.AIREG_HOME as string, "targets"), { recursive: true, mode: 0o700 });
  if (spec.file !== undefined) {
    await writeFile(
      join(env.AIREG_HOME as string, "targets", `${spec.id}.json`),
      JSON.stringify(spec.file),
    );
  }
  await registry(join(fixtures, "fx"), { name: "fx", slug: "fx" })
    .skill("ns/lint@1.0.0", { description: "Lints a change.", body: "Run the linter.\n" })
    .agent("ns/reviewer@1.0.0", { files: { "AGENT.md": AGENT } })
    .write();
  await writeFile(join(fixtures, "kit.mjs"), pluginAdapter());
  await writeFile(
    join(env.AIREG_HOME as string, "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  kit: ${join(fixtures, "kit.mjs")}\naccounts: []\njobs: []\n`,
  );
  const aireg = (args: readonly string[], cwd = project) => runCli(args, { cwd, home, env });
  const box = { home, project, env, aireg };
  await must(aireg(["init", "-y", "--for", spec.id]));
  await must(aireg(["registry", "add", join(fixtures, "fx"), "--as", "fx"]));
  await must(aireg(["registry", "add", "-g", join(fixtures, "fx"), "--as", "fx"]));
  return box;
}

async function must(ran: ReturnType<Sandbox["aireg"]>): Promise<void> {
  const { code, stdout, stderr } = await ran;
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}

/** Every path the target could read, with what each holds, sandbox paths written as `~`. */
function tree(home: string): string {
  const lines: string[] = [];
  const redact = (text: string) => text.replaceAll(home, "~");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const shown = relative(home, path).split(sep).join("/");
      if (OWN.some((own) => relative(home, path) === own)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) lines.push(`${shown} -> ${redact(readlinkSync(path))}`);
      else if (info.isDirectory()) {
        lines.push(`${shown}/`);
        walk(path);
      } else lines.push(`${shown} ${digest(redact(readFileSync(path, "utf8"))).slice(0, 12)}`);
    }
  };
  walk(home);
  return `${lines.join("\n")}\n`;
}

const placed = (listing: string) => listing.split("\n").filter((line) => !line.endsWith("/"));

async function installProject(box: Sandbox, id: string): Promise<void> {
  await must(box.aireg(["add", "fx/ns", "--all", "--for", id, "-y"]));
}

async function installUser(box: Sandbox, id: string): Promise<void> {
  await must(box.aireg(["add", "-g", "fx/ns", "--all", "--for", id, "--no-auto-update", "-y"]));
  const plugin = ["add", "-g", "https://kit.example", "--adapter", "kit", "--all"];
  await must(box.aireg([...plugin, "--for", id, "--no-auto-update", "-y"]));
}

/** Registers L1 for a target, and L2 where its program is installed and asked for. */
export function conformance(spec: Conformance): void {
  const golden = (scope: string) => join(import.meta.dirname, spec.id, `${scope}.tree`);
  const probes = spec.probes ?? [];
  const live =
    process.env.AIREG_CONFORMANCE === "1" &&
    probes.length > 0 &&
    probes.every((probe) => onPath(probe.argv[0] as string, process.env));
  const programs = [...new Set(probes.map((probe) => probe.argv[0]))].join(", ");
  // A skipped test shows only its name, so the name says what would run it.
  const l2 = live
    ? "L2: the target lists what aireg placed"
    : probes.length === 0
      ? "L2: not run, since no command of the target lists what it loaded"
      : `L2: runs with AIREG_CONFORMANCE=1 and ${programs} on PATH`;

  // Windows places a link as a junction or a copy, so its trees differ by design.
  describe.skipIf(process.platform === "win32")(`${spec.id} conformance`, () => {
    let box: Sandbox;
    let before: string;

    test.beforeAll(async () => {
      box = await sandbox(spec);
      before = tree(box.home);
    });

    test.afterAll(() => dispose(box));

    // A built-in target has a JSON copy, which proves a file can say all it does.
    test.skipIf(spec.file !== undefined)("its JSON twin resolves to the same target", async () => {
      const env = { HOME: box.home, AIREG_HOME: join(box.home, "twin") };
      const builtIn = resolveTargets(env)[spec.id];
      await mkdir(join(env.AIREG_HOME, "targets"), { recursive: true });
      const twin = join(import.meta.dirname, "..", "fixtures", "targets", `${spec.id}.json`);
      try {
        await copyFile(twin, join(env.AIREG_HOME, "targets", `${spec.id}.json`));
        expect({ ...resolveTargets(env)[spec.id], origin: "built-in" }).toEqual(builtIn);
      } finally {
        await rm(env.AIREG_HOME, { recursive: true, force: true });
      }
    });

    test("L1: places each kind in this project", async () => {
      await installProject(box, spec.id);
      await expect(tree(box.home)).toMatchFileSnapshot(golden("project"));
    });

    test("L1: places each kind in your user scope", async () => {
      await installUser(box, spec.id);
      await expect(tree(box.home)).toMatchFileSnapshot(golden("user"));
    });

    // A target's own root stays, emptied, as it does for a folder the target made itself.
    test("L1: remove takes back every file and link it placed", async () => {
      await removeAll(box);
      expect(placed(tree(box.home))).toEqual(placed(before));
    });

    // A sandbox of its own: the coding agent may write its own state as it runs.
    test.skipIf(!live)(
      l2,
      async () => {
        const own = await sandbox(spec);
        try {
          await installProject(own, spec.id);
          await installUser(own, spec.id);
          for (const probe of probes) {
            const [program, ...args] = probe.argv as [string, ...string[]];
            const cwd = probe.scope === "project" ? own.project : own.home;
            const ran = run(program, args, {
              cwd,
              env: { ...targetEnv(process.env), ...own.env },
              timeout: 60_000,
            });
            if (probe.stdin !== undefined) ran.child.stdin?.end(probe.stdin);
            const { stdout, stderr } = await ran;
            for (const want of probe.expect) expect(`${stdout}${stderr}`).toMatch(want);
          }
        } finally {
          await dispose(own);
        }
      },
      180_000,
    );
  });
}

const run = promisify(execFile);

/** A probe never signs in, and runs without this machine's credentials or the runner's variables. */
function targetEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = (name: string) =>
    !/token|key|secret|password|auth|askpass|cred/i.test(name) && !name.startsWith("VITEST");
  return Object.fromEntries(Object.entries(env).filter(([name]) => kept(name)));
}

async function removeAll(box: Sandbox): Promise<void> {
  await must(box.aireg(["remove", "ns/lint", "ns/reviewer", "--force", "-y"]));
  const user = ["ns/lint", "ns/reviewer", "kit/ship", "kit/planner"];
  await must(box.aireg(["remove", "-g", ...user, "--force", "-y"]));
}

async function dispose(box: Sandbox | undefined): Promise<void> {
  if (box === undefined) return;
  // As the e2e fixtures do: only a daemon that started has a log.
  if (existsSync(join(box.env.AIREG_HOME as string, "logs", "daemon.log"))) {
    await box.aireg(["daemon", "stop"]);
  }
  await rm(box.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
