import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { shortHash } from "#core/fs/hash.ts";
import { OPEN_TO_OTHERS, PRIVATE_DIR, PRIVATE_FILE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { NAME } from "#core/product.ts";
import { ensureHome, toolHome } from "#core/store/paths.ts";

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, its terminating NUL included. */
const SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

/** Keeps two aireg homes' sockets and services apart. */
export function homeIdentity(home: string): string {
  return shortHash(home);
}

function user(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

function isPrivate(info: { isDirectory(): boolean; uid: number; mode: number }): boolean {
  return (
    info.isDirectory() && info.uid === process.getuid?.() && (info.mode & OPEN_TO_OTHERS) === 0
  );
}

function privateAlready(dir: string): boolean {
  try {
    return isPrivate(lstatSync(dir));
  } catch {
    return false;
  }
}

/** Missing, so `privateDirectory` makes it this user's, or already theirs alone. */
function usable(dir: string): boolean {
  try {
    return isPrivate(lstatSync(dir));
  } catch (error) {
    return isMissing(error);
  }
}

function runtimeDir(env: NodeJS.ProcessEnv): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime) ? runtime : tmpdir();
}

function socketName(env: NodeJS.ProcessEnv): string {
  return `${NAME}-${user()}-${homeIdentity(toolHome(env))}.sock`;
}

const SECRET = /^[0-9a-f]{32}$/;

/** A random value kept in this home, written whole and then linked into place. */
function homeSecret(env: NodeJS.ProcessEnv, file: string): string {
  const path = join(toolHome(env), "state", file);
  try {
    return readSecret(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  mkdirSync(join(ensureHome(env), "state"), { recursive: true, mode: PRIVATE_DIR });
  const staging = `${path}.${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(staging, `${randomBytes(16).toString("hex")}\n`, {
    mode: PRIVATE_FILE,
    flag: "wx",
  });
  try {
    linkSync(staging, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(staging);
  }
  return readSecret(path);
}

function readSecret(path: string): string {
  const secret = readFileSync(path, "utf8").trim();
  if (!SECRET.test(secret)) {
    throw new Error(`${path} is not what aireg wrote there. Delete it and try again.`);
  }
  return secret;
}

const CHALLENGE = /^[0-9a-f]{64}$/;

export function daemonChallenge(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Signed with a key only this user's home holds, so a process of another user
 * that took the endpoint first cannot answer it.
 */
export function daemonProof(challenge: unknown): string | undefined {
  if (typeof challenge !== "string" || !CHALLENGE.test(challenge)) return undefined;
  const key = homeSecret(process.env, "daemon-key");
  return createHmac("sha256", key).update(challenge).digest("hex");
}

export function provesDaemon(challenge: string, proof: unknown): boolean {
  const expected = daemonProof(challenge);
  if (expected === undefined || typeof proof !== "string") return false;
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, Buffer.from(expected));
}

// Pipe names are machine-wide: a guessable one could be taken first. Node cannot check a pipe
// server's owner, and a name listed while the daemon runs can be taken once it stops: hence the proof.
function pipeName(env: NodeJS.ProcessEnv): string {
  return `\\\\.\\pipe\\${NAME}-${homeIdentity(toolHome(env))}-${homeSecret(env, "pipe-name")}`;
}

/**
 * In a directory only this user can enter, as tmux and ssh-agent do: the
 * runtime directory itself when it already is one, so the address stays put.
 */
export function rpcEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return pipeName(env);
  // A folder another user made first is passed over; the last one, in aireg's home, they cannot make.
  const dirs = [
    ...[runtimeDir(env), tmpdir(), "/tmp"].map((base) =>
      privateAlready(base) ? base : join(base, `${NAME}-${user()}`),
    ),
    join(toolHome(env), "run"),
  ];
  const candidates = dirs.filter(usable).map((dir) => join(dir, socketName(env)));
  return (
    candidates.find((path) => Buffer.byteLength(path) <= SOCKET_PATH_BYTES) ??
    join(dirs.at(-1) as string, socketName(env))
  );
}

/** Refuses an existing directory anybody else can enter. */
export async function privateDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  await mkdir(dir, { mode: PRIVATE_DIR }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!isPrivate(await lstat(dir))) {
    throw new Error(
      `The daemon will not use ${dir}, because another user owns it or can enter it.`,
    );
  }
}

/**
 * A socket is trusted only when this user owns it. Another user could otherwise
 * bind the address first and read every token sent to it.
 */
export async function assertOwnSocket(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(endpoint);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!info.isSocket() || info.uid !== process.getuid?.()) {
    throw new Error(`aireg will not connect to ${endpoint}, because it is not a socket you own.`);
  }
}

/** True when something accepts connections on this endpoint. */
export function listening(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createConnection(endpoint);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      // Reset on connect: something listens, but is serving as many clients as it allows.
      else if (error.code === "ECONNRESET") resolve(true);
      else reject(error);
    });
  });
}
