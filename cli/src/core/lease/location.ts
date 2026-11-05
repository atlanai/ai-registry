import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { redirection } from "#adapter/files.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { shortHash } from "#core/fs/hash.ts";
import { posixRelative } from "#core/fs/path.ts";
import { ensureHome, leasesDir, type Roots } from "#core/store/paths.ts";

/**
 * Canonical, because `/tmp` and `/private/tmp`, or `~/Desktop` and `~/desktop`, reaching one
 * project must not take two leases. The lock may not exist yet, so resolve the closest folder that does.
 */
export function canonicalLock(lock: string): string {
  const full = resolve(lock);
  const rest = [basename(full)];
  for (let dir = dirname(full); ; dir = dirname(dir)) {
    try {
      return join(realpathSync.native(dir), ...rest);
    } catch {
      if (dirname(dir) === dir) return full;
      rest.unshift(basename(dir));
    }
  }
}

/** The lockfile path names the file set a scope owns, so it is the identity. */
export function leaseKey(roots: Pick<Roots, "lock">): string {
  return shortHash(canonicalLock(roots.lock));
}

export function leaseDir(roots: Pick<Roots, "scope" | "lock">, env: NodeJS.ProcessEnv): string {
  return join(parentOf(roots, env), `${leaseKey(roots)}.lease`);
}

/**
 * In the project's own `.registry/`, so every writer of the project shares it
 * whatever its `AIREG_HOME`. The user scope's stay in `AIREG_HOME`.
 */
function parentOf(roots: Pick<Roots, "scope" | "lock">, env: NodeJS.ProcessEnv): string {
  return roots.scope === "user"
    ? leasesDir(env)
    : join(dirname(canonicalLock(roots.lock)), "leases");
}

/** Refuses a path the lease would write or remove through a link. */
export type Guard = (path: string) => Promise<void>;

/**
 * A link from `.registry` down to the lease would carry its writes and removals out of the
 * project. The user scope's leases live in `AIREG_HOME`, which `ensureHome` sets up.
 */
export function containment(roots: Pick<Roots, "scope" | "lock">, env: NodeJS.ProcessEnv): Guard {
  if (roots.scope === "user") return async () => {};
  const folder = dirname(resolve(roots.lock));
  const registry = dirname(parentOf(roots, env));
  return async (path) => {
    // The scope folder alone: a symlinked route to the project itself is still one project.
    refuseLink(folder, folder);
    refuseLink(registry, path);
  };
}

/** A committed link on the way to the lease is the project's to replace, so it is named. */
function refuseLink(root: string, path: string): void {
  const found = redirection(root, path);
  if (found === undefined) return;
  const what = found.problem === "symlink" ? "a symlink" : "not a directory";
  throw new AiregError(`${found.at} is ${what} in a managed path.`, {
    code: ErrorCode.Invalid,
    hint: `Replace ${posixRelative(dirname(root), found.at)} with a real folder.`,
  });
}

/** A project's `.registry/` is committed, so its lease folder ignores itself. */
export async function prepare(
  roots: Pick<Roots, "scope" | "lock">,
  dir: string,
  guard: Guard,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const user = roots.scope === "user";
  if (user) ensureHome(env);
  await guard(dir);
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  if (user) return;
  await writeFile(join(parent, ".gitignore"), "*\n", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

export function metaPath(dir: string): string {
  return join(dir, "meta.json");
}

/**
 * Where a release moves its lease before removing it: half removed in place, the folder reads
 * as stale, and the metadata a claimant writes into it would be removed with the rest.
 */
export function asideOf(dir: string, id: string): string {
  return `${dir}.${id}.released`;
}
