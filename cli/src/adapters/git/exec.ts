import { type ChildProcess, spawn } from "node:child_process";
import { AdapterError, type Failure, withAbsolutePath } from "#adapter/index.ts";
import { gitEnv } from "./env.ts";
import { ID } from "./errors.ts";

/** The adapter contract's own words, so the git adapter passes a failure through unchanged. */
type GitFailure = Extract<Failure, "not_found" | "unauthorized" | "unavailable" | "invalid">;

export class GitError extends AdapterError {
  declare readonly failure: GitFailure;
  readonly stderr: string;

  constructor(failure: GitFailure, message: string, stderr = "", hint?: string) {
    super(ID, failure, message, { hint });
    this.stderr = stderr;
  }

  /** Refused by an organization's SAML SSO, which needs its own fix. */
  get sso(): boolean {
    const text = this.stderr.toLowerCase();
    return SSO_MARKERS.some((marker) => text.includes(marker));
  }
}

const SSO_MARKERS = [
  "saml sso",
  "enforced sso",
  "enabled or enforced saml",
  "re-authorize the oauth application",
];

const AUTH_MARKERS = [
  "authentication failed",
  "could not read username",
  "permission denied",
  "invalid username or password",
  "returned error: 403",
];

const NOT_FOUND_MARKERS = [
  "repository not found",
  "returned error: 404",
  "does not appear to be a git repository",
  "couldn't find remote ref",
];

/** Git repeats itself across several lines; the first fatal line is the cause. */
function firstFatal(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const fatal = lines.find((line) => line.startsWith("fatal:") || line.startsWith("error:"));
  return (fatal ?? lines[0] ?? "git failed").replace(/^(fatal|error):\s*/, "");
}

/**
 * Failures are classified once, here. Repeating substring checks at each call
 * site is how a new caller silently loses the SSO hint.
 */
function classify(stderr: string): GitFailure {
  const text = stderr.toLowerCase();
  if (SSO_MARKERS.some((m) => text.includes(m))) return "unauthorized";
  if (NOT_FOUND_MARKERS.some((m) => text.includes(m))) return "not_found";
  if (AUTH_MARKERS.some((m) => text.includes(m))) return "unauthorized";
  return "unavailable";
}

/** What the host allows a git operation: from the connection's limits, or set for the call. */
export interface GitLimits {
  timeoutMs: number;
  /** The setting that allows more time, which a timeout's hint names. */
  timeoutSetting?: string | undefined;
  /** Aborting kills git, so a stopped run does not wait out a hung fetch. */
  signal?: AbortSignal | undefined;
}

export interface GitOptions extends GitLimits {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_BUFFER = 32 * 1024 * 1024;

/** Its own process group, so a timeout also stops the helpers git starts, such as `git-remote-http`. */
const GROUPED = process.platform !== "win32";

/** Git runs still going, so an interrupted command can stop them on its way out. */
const running = new Set<ChildProcess>();

function kill(child: ChildProcess): void {
  try {
    if (GROUPED && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

/** In its own group git does not get the terminal's Ctrl-C, so an interrupt passes it on. */
export function stopGit(): void {
  for (const child of running) kill(child);
}

function aborted(signal: AbortSignal): Error {
  return Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
    cause: signal.reason,
  });
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** At most this many git network calls at once, so dozens of registries stay under a host's limits. */
const NETWORK_AT_ONCE = 6;
const NETWORK = new Set(["clone", "fetch", "ls-remote"]);
let networking = 0;
const queued: (() => void)[] = [];

/** Runs `task` once a network slot is free; local git work is never held back. */
async function inNetworkSlot<T>(task: () => Promise<T>): Promise<T> {
  if (networking >= NETWORK_AT_ONCE) await new Promise<void>((admit) => queued.push(admit));
  else networking += 1;
  try {
    return await task();
  } finally {
    // Handed over, not released and retaken, which would let another in.
    const next = queued.shift();
    if (next === undefined) networking -= 1;
    else next();
  }
}

function spawnTool(
  binary: "git" | "gh",
  args: readonly string[],
  options: GitOptions,
  timeout: number,
): Promise<Ran> {
  const network = binary === "gh" || args.some((arg) => NETWORK.has(arg));
  const run = () => spawnOne(binary, args, options, timeout);
  return network ? inNetworkSlot(run) : run();
}

/** Subprocess handling is confined to this module: git, and `gh` where it clones. */
function spawnOne(
  binary: "git" | "gh",
  args: readonly string[],
  options: GitOptions,
  timeout: number,
): Promise<Ran> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(aborted(signal));
      return;
    }
    let env: NodeJS.ProcessEnv;
    try {
      env = binary === "git" ? gitEnv(options.env) : withAbsolutePath(options.env ?? process.env);
    } catch (error) {
      // An empty PATH would find a program in the checkout git works in.
      reject(
        new GitError(
          "invalid",
          (error as Error).message,
          "",
          `Set PATH to the absolute folders that hold ${binary}, then run the command again.`,
        ),
      );
      return;
    }
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env,
      detached: GROUPED,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        overflow = true;
        kill(child);
      } else into.push(chunk);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeout);
    const stop = () => kill(child);
    signal?.addEventListener("abort", stop, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      running.delete(child);
    };
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      if (signal?.aborted === true) {
        reject(aborted(signal));
        return;
      }
      const stderr = Buffer.concat(err).toString("utf8");
      if (overflow) {
        reject(Object.assign(new Error("git printed more than 32 MiB of output."), { stderr }));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr, timedOut });
    });
  });
}

function notInstalled(error: unknown): GitError | undefined {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
    ? new GitError(
        "invalid",
        "git is not installed, or not on your PATH.",
        "",
        "Install git, then run the command again.",
      )
    : undefined;
}

export async function git(args: readonly string[], options: GitOptions): Promise<string> {
  const timeout = options.timeoutMs;
  let ran: Ran;
  try {
    ran = await spawnTool("git", args, options, timeout);
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    if (error instanceof GitError) throw error;
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw notInstalled(error) ?? new GitError("unavailable", (error as Error).message, stderr);
  }
  if (ran.timedOut) {
    throw new GitError(
      "unavailable",
      `git timed out after ${timeout < 1000 ? `${timeout}ms` : `${Math.round(timeout / 1000)}s`}.`,
      ran.stderr,
      options.timeoutSetting === undefined
        ? "Clone the repository yourself and add its local path."
        : `Raise the limit with ${options.timeoutSetting}, or clone the repository yourself and add its local path.`,
    );
  }
  if (ran.code === 0) return ran.stdout;
  throw new GitError(classify(ran.stderr), firstFatal(ran.stderr), ran.stderr);
}

export interface GitAttempt {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git when a non-zero exit is data rather than an exception. */
export async function gitTry(args: readonly string[], options: GitOptions): Promise<GitAttempt> {
  let ran: Ran;
  try {
    ran = await spawnTool("git", args, options, options.timeoutMs);
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw notInstalled(error) ?? error;
  }
  if (ran.timedOut) throw new GitError("unavailable", "git timed out.", ran.stderr);
  return { code: ran.code ?? 1, stdout: ran.stdout, stderr: ran.stderr };
}

export async function gitVersion(): Promise<string | undefined> {
  try {
    return (await git(["--version"], { timeoutMs: 5000 })).trim();
  } catch {
    return undefined;
  }
}

/** `gh` run the way git is, with its exit status as data. */
export async function gh(
  args: readonly string[],
  options: GitOptions,
): Promise<{ code: number; stderr: string }> {
  const ran = await spawnTool("gh", args, options, options.timeoutMs);
  return { code: ran.timedOut ? 1 : (ran.code ?? 1), stderr: ran.stderr };
}
