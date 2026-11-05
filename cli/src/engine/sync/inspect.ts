import { credentialsForManifest } from "#accounts/credentials.ts";
import type { Account } from "#core/config/model.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load } from "#engine/scope/load.ts";
import type { RunScope } from "./narrow.ts";
import { type Scan, scan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

export function syncOptions(job: ScopeWork, refs: RunScope): CommonOptions {
  return {
    scope: job.scope,
    targets: undefined,
    select: refs === undefined ? ["*"] : [...refs],
    yes: true,
    all: refs === undefined,
    dryRun: false,
    frozen: false,
    force: false,
    copy: false,
  };
}

/** A manifest that has drifted away from the account must not reach the provider. */
export function registryOf(loaded: Loaded, account: Account): RegistrySource {
  const source = loaded.manifest.registries[account.registry];
  if (source === undefined) {
    throw unknownRegistry(
      account.registry,
      loaded.roots.scope,
      Object.keys(loaded.manifest.registries),
    );
  }
  return source;
}

export interface Inspected {
  loaded: Loaded;
  common: CommonOptions;
  found: Scan;
}

/** The first half of `executeSync`, stopped before anything is written. */
export async function inspect(
  job: ScopeWork,
  account: Account,
  signal: AbortSignal,
): Promise<Inspected> {
  // Everything the registry publishes, so a report can offer the names this job skips.
  const common = syncOptions(job, undefined);
  const loaded = await load(common, job.root);
  // Refuses an account whose registry the manifest no longer declares.
  registryOf(loaded, account);
  const found = await scan(loaded, common, {
    aliases: [account.registry],
    credentials: await credentialsForManifest(loaded.manifest.registries, job.root, signal, [
      account.registry,
    ]),
    signal,
  });
  return { loaded, common, found };
}
