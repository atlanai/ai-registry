import { formatVersion, gte, parseVersion } from "#adapter/semver.ts";
import { readConfig } from "#core/config/repository.ts";
import { releaseStamp } from "#core/release/stamp.ts";
import { downloadAdapter, resolveAdapter } from "./fetch.ts";
import { adapterSpecifier, writeInstalled } from "./store.ts";

export interface AdapterUpdateDeps {
  stamp?: typeof releaseStamp;
  resolve?: typeof resolveAdapter;
  download?: typeof downloadAdapter;
  install?: typeof writeInstalled;
  signal?: AbortSignal;
  onFailure?: (id: string, error: unknown) => void;
}

/** The version of an origin install; a module path the user wrote is theirs to manage. */
export function originVersion(id: string, specifier: string): string | undefined {
  const version = specifier.split("/")[3] ?? "";
  const parsed = parseVersion(version);
  if (parsed === undefined || formatVersion(parsed) !== version) return undefined;
  return adapterSpecifier(id, version) === specifier ? version : undefined;
}

/**
 * Moves each origin install to its channel head. writeInstalled loads the module
 * before pinning it, so a head this CLI cannot run leaves the old pin in place.
 */
export async function updateAdapters(
  env: NodeJS.ProcessEnv = process.env,
  deps: AdapterUpdateDeps = {},
): Promise<string[]> {
  const stamp = (deps.stamp ?? releaseStamp)(env);
  if (stamp === undefined) return [];
  const updated: string[] = [];
  for (const [id, specifier] of Object.entries((await readConfig(env)).adapters)) {
    const installed = originVersion(id, specifier);
    if (installed === undefined) continue;
    try {
      const want = { id, version: undefined };
      const release = await (deps.resolve ?? resolveAdapter)(want, stamp, fetch, deps.signal);
      if (gte(installed, release.version)) continue;
      const bytes = await (deps.download ?? downloadAdapter)(release, fetch, deps.signal);
      await (deps.install ?? writeInstalled)(id, release.version, bytes, env);
      updated.push(`${id} ${release.version}`);
    } catch (error) {
      // Retried on the next check; the pinned version keeps working meanwhile.
      deps.onFailure?.(id, error);
    }
  }
  return updated;
}
