import { randomBytes } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { gte, parseVersion } from "#adapter/semver.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { canonical } from "#core/fs/canonical.ts";
import { EXECUTABLE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import {
  binDir,
  cliRoot,
  currentLink,
  shimPath,
  versionBin,
  versionDir,
} from "#core/release/layout.ts";
import { standaloneShim } from "#core/release/shim.ts";
import { ensureHome } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";

const WINDOWS = process.platform === "win32";

export async function installedVersion(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const target = WINDOWS
      ? (await readFile(currentLink(env), "utf8")).trim()
      : await readlink(currentLink(env));
    if (target !== "") return target;
  } catch {
    // Source and npm installs have no ~/.aireg/cli/current yet.
  }
  return VERSION;
}

/**
 * The caller has already held `bytes` to the signed sha256 and size. A running
 * executable cannot be written through on POSIX, so the write is renamed over it.
 */
export async function installBinary(
  version: string,
  bytes: Uint8Array,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const bin = versionBin(version, env);
  ensureHome(env);
  await mkdir(versionDir(version, env), { recursive: true });
  if (WINDOWS) {
    const staged = `${bin}.${process.pid}.tmp`;
    await writeAtomic(staged, bytes, EXECUTABLE);
    await swapIn(staged, bin);
  } else {
    await writeAtomic(bin, bytes, EXECUTABLE);
  }
  return await goLive(version, bin, env);
}

/**
 * Places an executable already on disk. The installer's staged copy, inside aireg's
 * home, is renamed into place; any other file is copied beside the target and renamed.
 */
export async function installBinaryFrom(
  version: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const bin = versionBin(version, env);
  ensureHome(env);
  if (canonical(path) !== canonical(bin)) {
    await mkdir(versionDir(version, env), { recursive: true });
    if (isWithin(canonical(cliRoot(env)), canonical(path))) {
      await chmod(path, EXECUTABLE);
      await swapIn(path, bin);
    } else {
      const staged = `${bin}.${process.pid}.tmp`;
      try {
        await copyFile(path, staged);
        await chmod(staged, EXECUTABLE);
        await swapIn(staged, bin);
      } finally {
        await rm(staged, { force: true });
      }
    }
  }
  return await goLive(version, bin, env);
}

export async function versionOnDisk(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await access(versionBin(version, env), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function goLive(version: string, bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    await access(bin, constants.X_OK);
  } catch {
    throw new Error(`Installed aireg ${version}, but ${bin} is not executable.`);
  }
  await activate(version, env);
  await sweepReplaced(dirname(bin));
  return bin;
}

/**
 * Renames `staged` over `target`. Windows refuses that while `target` runs, but lets the
 * running file be renamed, so it moves aside until nothing runs it.
 */
async function swapIn(staged: string, target: string): Promise<void> {
  if (WINDOWS) {
    await rename(target, `${target}.${randomBytes(4).toString("hex")}.old`).catch(
      (error: unknown) => {
        if (!isMissing(error)) throw error;
      },
    );
  }
  await rename(staged, target);
}

/** Deletes what `swapIn` moved aside; one a process still runs stays until a later install. */
async function sweepReplaced(dir: string): Promise<void> {
  if (!WINDOWS) return;
  for (const entry of await readdir(dir).catch(() => [])) {
    if (entry.endsWith(".old")) await rm(join(dir, entry), { force: true }).catch(() => undefined);
  }
}

async function activate(version: string, env: NodeJS.ProcessEnv): Promise<void> {
  await pointCurrent(version, env);
  await writeShims(version, env);
}

/**
 * A symlink the shim follows. Windows runs a copy instead of a shim, and a link there needs
 * Developer Mode, so `current` is a file that names the version.
 */
async function pointCurrent(version: string, env: NodeJS.ProcessEnv): Promise<void> {
  const current = currentLink(env);
  if (WINDOWS) {
    await writeAtomic(current, `${version}\n`);
    return;
  }
  const tmp = `${current}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await symlink(version, tmp);
  await rename(tmp, current);
}

/** Windows runs no shell script from PATH, so the binary itself goes there. */
async function writeShims(version: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!WINDOWS) {
    await writeAtomic(shimPath(env), standaloneShim(), EXECUTABLE);
    await chmod(binDir(env), EXECUTABLE);
    return;
  }
  await mkdir(binDir(env), { recursive: true });
  const staged = `${shimPath(env)}.${process.pid}.tmp`;
  try {
    await copyFile(versionBin(version, env), staged);
    await swapIn(staged, shimPath(env));
  } finally {
    await rm(staged, { force: true });
  }
  await sweepReplaced(binDir(env));
}

async function listedVersions(env: NodeJS.ProcessEnv): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(cliRoot(env), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && parseVersion(entry.name) !== undefined)
    .map((entry) => entry.name)
    .sort((a, b) => (gte(a, b) ? -1 : 1));
}

export async function previousInstalled(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const current = await installedVersion(env);
  const previous = (await listedVersions(env)).find((version) => version !== current);
  if (previous === undefined) {
    throw new AiregError("No earlier version of aireg is installed to roll back to.", {
      code: ErrorCode.NotFound,
      hint: "Run `aireg self update` first; it keeps the version it replaces, to roll back to.",
    });
  }
  return previous;
}

export async function rollback(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const previous = await previousInstalled(env);
  await activate(previous, env);
  return previous;
}

/** Oldest versions beyond `keep` newest, newest-first input not required. */
export function versionsToPrune(versions: readonly string[], keep = 2): string[] {
  return [...versions].sort((a, b) => (gte(a, b) ? -1 : 1)).slice(keep);
}

export async function pruneOld(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const current = await installedVersion(env);
  // An installer killed mid-download leaves its staging folder behind.
  for (const entry of await readdir(cliRoot(env))) {
    if (entry.startsWith(".incoming-")) {
      await rm(join(cliRoot(env), entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const names = await listedVersions(env);
  for (const stale of versionsToPrune(
    names.filter((name) => name !== current),
    1,
  )) {
    // Windows cannot delete a binary a process still runs; the next update tries again.
    await rm(join(cliRoot(env), stale), { recursive: true, force: true }).catch(() => undefined);
  }
}
