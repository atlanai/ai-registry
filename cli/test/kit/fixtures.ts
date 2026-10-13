import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as base, expect, vi } from "vitest";
import { RpcClient } from "#daemon/rpc/client.ts";
import { rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import type { ClientInfo } from "#daemon/rpc/protocol.ts";
import { DaemonRuntime } from "#daemon/runtime.ts";
import { testClient } from "./daemon.ts";
import { type Home, makeHome } from "./home.ts";
import { type Places, redact, redactPlaces, serializer } from "./redact.ts";
import { exec, type Ran, runCli } from "./run.ts";
import { tempDir } from "./temp.ts";

interface AiregOptions {
  /** Defaults to the project. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Flags for node itself, ahead of the entry point. */
  node?: string[];
  /** Written to standard input, which is then closed. */
  input?: string;
}

export type Aireg = (args: readonly string[], options?: AiregOptions) => Promise<Ran>;

export interface Daemon {
  /** Opens a runtime on the test home and connects one client; both close after the test. */
  start(info?: ClientInfo): Promise<{ runtime: DaemonRuntime; client: RpcClient }>;
  /** Another client of the running daemon, closed after the test. */
  connect(info?: ClientInfo): Promise<RpcClient>;
}

export interface Git {
  /** Runs git with the test identity and signing off, returning trimmed stdout. */
  (cwd: string, ...args: string[]): Promise<string>;
  init(dir: string): Promise<void>;
  /** Stages everything and commits it, returning the new commit. */
  commit(dir: string, message?: string): Promise<string>;
  tag(dir: string, name: string): Promise<void>;
}

const IDENTITY = { name: "aireg test", email: "test@example.com" };

/** Signing off explicitly: a developer's global `tag.gpgsign` would otherwise reach in. */
const GIT_CONFIG = [
  "[user]",
  `\tname = ${IDENTITY.name}`,
  `\temail = ${IDENTITY.email}`,
  "[commit]",
  "\tgpgsign = false",
  "[tag]",
  "\tgpgsign = false",
  "[init]",
  "\tdefaultBranch = main",
  "",
].join("\n");

expect.addSnapshotSerializer(serializer);

export type { Home };

async function makeGit(home: Home): Promise<Git> {
  // The spawned CLI authors commits too, so the identity lives in the test home.
  await writeFile(join(home.dir, ".gitconfig"), GIT_CONFIG);
  const env = {
    ...process.env,
    ...home.env,
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd, env })).stdout.trim();
  return Object.assign(git, {
    async init(dir: string) {
      await mkdir(dir, { recursive: true });
      await git(dir, "init", "-q");
    },
    async commit(dir: string, message = "commit") {
      await git(dir, "add", "-A");
      await git(dir, "commit", "-qm", message);
      return await git(dir, "rev-parse", "HEAD");
    },
    async tag(dir: string, name: string) {
      await git(dir, "tag", name);
    },
  });
}

function cliIn(home: Home, project: string): Aireg {
  return (args, options = {}) =>
    runCli(args, {
      cwd: options.cwd ?? project,
      home: home.dir,
      env: { ...home.env, ...options.env },
      node: options.node ?? [],
      ...(options.input === undefined ? {} : { input: options.input }),
    });
}

/** A daemon an `add -g` started outlives its test, and writes logs while its folder is removed. */
async function stopDaemon(home: Home): Promise<void> {
  if (existsSync(join(home.aireg, "logs", "daemon.log"))) {
    await cliIn(home, home.dir)(["daemon", "stop"]);
  }
}

// biome-ignore lint/correctness/noEmptyPattern: vitest reads a fixture's dependencies from this pattern.
async function makeTmp({}, { onCleanup }: Cleanup): Promise<string> {
  const dir = await tempDir("test-");
  onCleanup(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeProject({ tmp }: { tmp: string }): Promise<string> {
  const dir = join(tmp, "project");
  await mkdir(dir, { recursive: true });
  return dir;
}

interface Cleanup {
  onCleanup(cleanup: () => unknown): void;
}

export const test = base
  /** A folder for the whole file, for what every test reads and none changes, such as a registry. */
  .extend("fileTmp", { scope: "file" }, makeTmp)
  .extend("tmp", makeTmp)
  .extend("home", async ({ tmp }, { onCleanup }): Promise<Home> => {
    const home = await makeHome(join(tmp, "home"));
    // In-process code reads the same variables a spawned CLI is given.
    for (const [name, value] of Object.entries(home.env)) vi.stubEnv(name, value);
    onCleanup(async () => {
      vi.unstubAllEnvs();
      await stopDaemon(home);
    });
    return home;
  })
  .extend("project", makeProject)
  .extend("aireg", ({ home, project }) => cliIn(home, project))
  /** Output with this test's folders, digests, times and the CLI version as placeholders. */
  .extend("redact", ({ tmp, home, project }, { onCleanup }) => {
    const places: Places = { root: tmp, home: home.dir, project };
    redactPlaces(places);
    onCleanup(() => redactPlaces({}));
    return (text: string) => redact(text, places);
  })
  .extend("daemon", ({ home: _ }, { onCleanup }): Daemon => {
    let runtime: DaemonRuntime | undefined;
    const clients: RpcClient[] = [];
    onCleanup(async () => {
      for (const client of clients) client.close();
      await runtime?.close();
    });
    const connect = async (info = testClient("test")) => {
      const client = await RpcClient.connect(rpcEndpoint(), info);
      clients.push(client);
      return client;
    };
    return {
      async start(info) {
        runtime = await DaemonRuntime.open("test");
        await runtime.listen();
        return { runtime, client: await connect(info) };
      },
      connect,
    };
  })
  .extend("git", ({ home }) => makeGit(home));

/** `test`, with every test in its own home and aireg folder: for code that reads HOME or AIREG_* itself. */
export const homeTest = test.extend("inHome", { auto: true }, async ({ home }) => {
  await mkdir(home.aireg, { recursive: true, mode: 0o700 });
  return home;
});

/**
 * One folder, home, project and git identity per file, for e2e suites whose tests build on
 * the ones before; the spawned CLI gets the home's variables, as nothing is stubbed in process.
 */
export const fileTest = base
  .extend("tmp", { scope: "file" }, makeTmp)
  .extend("home", { scope: "file" }, async ({ tmp }, { onCleanup }) => {
    const home = await makeHome(join(tmp, "home"));
    onCleanup(() => stopDaemon(home));
    return home;
  })
  .extend("project", { scope: "file" }, makeProject)
  .extend("aireg", { scope: "file" }, ({ home, project }) => cliIn(home, project))
  .extend("git", { scope: "file" }, ({ home }) => makeGit(home));
