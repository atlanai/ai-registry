import { resolve } from "node:path";
import { isLocalPath } from "#adapter/paths.ts";
import { list as listOf, plural, withoutCredentials } from "#adapter/text.ts";
import type { Probed } from "#cli/source.ts";
import { comparableLocation, sourceKey } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { readConfig } from "#core/config/repository.ts";
import { credentialOrigin } from "#core/credentials/origin.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type Lock, type LockArtifact, writeLock } from "#core/lock.ts";
import type { Manifest, RegistrySource } from "#core/manifest.ts";
import { formatRef } from "#core/ref.ts";
import type { Roots } from "#core/store/paths.ts";

/** A declared name taking a new address, with what was checked against it. */
export interface Move {
  from: string;
  /** Installed artifacts the new address serves unchanged. */
  kept: number;
  /** The new address as read, which the lock records; absent when it could not be read. */
  read: { adapter: string; revision: string | undefined } | undefined;
}

/**
 * A name declared elsewhere moves only when the new address serves every artifact installed
 * from it, at its version and with the same content, so nothing installed changes underneath.
 */
export async function moveOf(
  roots: Roots,
  manifest: Manifest,
  lock: Lock,
  alias: string,
  declared: RegistrySource,
  source: Probed | undefined,
): Promise<Move | undefined> {
  const existing = manifest.registries[alias];
  // A folder compares as its resolved path, since C:\ parses as a URL; else as the lock keys it.
  const at = (location: string) =>
    isLocalPath(location)
      ? resolve(expandLocation(location, roots.base))
      : comparableLocation(location);
  if (existing === undefined || at(existing.location) === at(declared.location)) return undefined;

  const to = withoutCredentials(declared.location);
  const rows = Object.values(lock.artifacts).filter(
    (row) => row.registry === alias && row.content !== undefined,
  );
  if (rows.length > 0 && source === undefined) {
    throw new AiregError(
      `Cannot read ${to}, so cannot check that it serves the ${plural(rows.length, "artifact")} installed from registry ${alias}.`,
      {
        code: ErrorCode.Unauthorized,
        hint: `Declare it under another name to sign in: \`aireg registry add ${to} --as <name>\`, then \`aireg auth login <name>\`.`,
      },
    );
  }

  const missing: string[] = [];
  const changed: string[] = [];
  for (const row of rows) {
    const served = await source?.digestOf({
      name: row.name,
      namespace: row.namespace,
      kind: row.kind,
      ...(row.version === undefined ? {} : { version: row.version }),
    });
    if (served === undefined) missing.push(named(alias, row));
    else if (served !== row.content) changed.push(named(alias, row));
  }
  if (missing.length > 0 || changed.length > 0) {
    const differences = [
      ...(missing.length === 0 ? [] : [`it has no ${listOf(missing)}`]),
      ...(changed.length === 0 ? [] : [`it serves ${listOf(changed)} with other content`]),
    ];
    throw new AiregError(
      `${to} does not serve what was installed from registry ${alias}: ${differences.join(", and ")}.`,
      {
        code: ErrorCode.Conflict,
        hint: `Move ${alias} to an address that serves them, or remove them first with \`aireg remove\`.`,
      },
    );
  }
  return {
    from: existing.location,
    kept: rows.length,
    read: source === undefined ? undefined : { adapter: source.adapter, revision: source.revision },
  };
}

function named(alias: string, row: LockArtifact): string {
  const { namespace, kind, name, version } = row;
  return formatRef({ registry: alias, namespace, kind, name, version });
}

/** The lock names where its rows came from, so it follows the manifest to the new address. */
export async function recordMove(
  roots: Roots,
  lock: Lock,
  alias: string,
  declared: RegistrySource,
  move: Move,
): Promise<void> {
  const locked = lock.registries[alias];
  if (locked === undefined || move.read === undefined) return;
  lock.registries[alias] = {
    location: declared.location,
    adapter: move.read.adapter,
    key: sourceKey(declared.location, declared.config),
    config: declared.config,
    revision: move.read.revision,
  };
  await writeLock(roots, lock);
}

/** A sign-in goes only to the origin it was issued for, so one left behind needs renewing. */
export async function signInLeftBehind(
  roots: Roots,
  alias: string,
  declared: RegistrySource,
  move: Move,
): Promise<boolean> {
  const origin = (location: string) => credentialOrigin(expandLocation(location, roots.base));
  if (origin(move.from) === origin(declared.location)) return false;
  const config = await readConfig().catch(() => undefined);
  return config?.accounts.some((account) => account.registry === alias) ?? false;
}
