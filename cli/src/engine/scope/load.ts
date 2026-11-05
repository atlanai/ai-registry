import { unlockCommand } from "#core/lease/errors.ts";
import type { LeaseHolder } from "#core/lease/holder.ts";
import { withLease } from "#core/lease/lease.ts";
import { type Lock, readLock } from "#core/lock.ts";
import { formatManifest } from "#core/manifest/format.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { readManifest } from "#core/manifest/repository.ts";
import type { Roots, Scope } from "#core/store/paths.ts";
import { scopeName } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import { resolveTargets } from "#core/target/table.ts";
import type { Printer } from "#core/term/printer.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Outside, scopeRoots } from "./locate.ts";

export interface Loaded {
  roots: Roots;
  /** This process's, which `targetTable` was resolved with. */
  env: NodeJS.ProcessEnv;
  manifest: Manifest;
  lock: Lock;
  /** Nothing in a project changes it. */
  targetTable: Targets;
  /** The manifest as loaded, so a run that did not edit it leaves the file alone. */
  manifestAsRead: string;
}

export async function load(
  common: CommonOptions,
  cwd: string,
  outside: Outside = "fail",
): Promise<Loaded> {
  return read(scopeRoots(common, cwd, outside));
}

/**
 * Holds the scope's lease and reads it under the lease, so a change another process
 * wrote meanwhile is kept, not overwritten. One writer per scope, across processes.
 */
export async function withScope<T>(
  roots: Roots,
  run: (loaded: Loaded) => Promise<T>,
  printer?: Printer,
): Promise<T> {
  const onWaiting =
    printer === undefined
      ? undefined
      : (holder: LeaseHolder | undefined) => waiting(printer, roots.scope, holder);
  return withLease(roots, { wait: true, onWaiting }, async () => run(await read(roots)));
}

/** Said at once, without --verbose: a silent wait reads as a hang. */
function waiting(printer: Printer, scope: Scope, holder: LeaseHolder | undefined): void {
  const who = holder === undefined ? `another aireg process` : `aireg (pid ${holder.pid})`;
  printer.warning(`Waiting for ${who} to finish writing ${scopeName(scope)}.`);
  printer.hint(`Wait for it to finish, or run ${unlockCommand(scope)} if it has stopped.`);
}

export async function read(roots: Roots): Promise<Loaded> {
  const lock = await readLock(roots);
  const manifest = await readManifest(roots.manifest);
  const env = process.env;
  const targetTable = resolveTargets(env);
  return { roots, env, manifest, lock, targetTable, manifestAsRead: formatManifest(manifest) };
}
