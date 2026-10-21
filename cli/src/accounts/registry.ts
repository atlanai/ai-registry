import type { SourceAdapter } from "#adapter/index.ts";
import { withoutCredentials } from "#adapter/text.ts";
import { comparableLocation, sourceKey } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor, declaredLayout } from "#core/adapter/registry.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import {
  type Manifest,
  type RegistrySource,
  readManifest,
  unknownRegistry,
  writeManifest,
} from "#core/manifest.ts";
import { roots, type Scope } from "#core/store/paths.ts";

export interface ResolvedRegistry {
  alias: string;
  source: RegistrySource;
  /** Absolute: a relative path in the manifest is relative to its own root. */
  location: string;
  adapter: SourceAdapter;
  key: string;
}

export async function readRootManifest(
  scope: Scope = "user",
  cwd: string = process.cwd(),
): Promise<Manifest> {
  return readManifest(roots(scope, cwd).manifest);
}

function declaredIn(manifest: Manifest, alias: string, scope: Scope): RegistrySource {
  const source = manifest.registries[alias];
  if (source === undefined) throw unknownRegistry(alias, scope, Object.keys(manifest.registries));
  return source;
}

export async function resolveRegistry(
  manifest: Manifest,
  alias: string,
  scope: Scope,
  cwd: string = process.cwd(),
): Promise<ResolvedRegistry> {
  const source = declaredIn(manifest, alias, scope);
  const location = expandLocation(source.location, cwd);
  return {
    alias,
    source,
    location,
    adapter: await adapterFor(location, source.adapter, declaredLayout(source.config)),
    key: sourceKey(location, source.config),
  };
}

/**
 * A host that knows its own address has nowhere else to say so: every other
 * route into `manifest.yml` creates a job as a side effect. A name declared at
 * another address is refused, so a sign-in never reaches the one not named.
 */
export async function declareRegistryFor(alias: string, source: RegistrySource): Promise<void> {
  const cwd = process.cwd();
  const user = roots("user", cwd);
  const manifest = await readManifest(user.manifest);
  const held = manifest.registries[alias];
  if (held !== undefined) {
    const theirs = expandLocation(held.location, cwd);
    const asked = expandLocation(source.location, cwd);
    if (comparableLocation(theirs) === comparableLocation(asked)) return;
    throw new AiregError(
      `${alias} is ${withoutCredentials(theirs)} in your user scope, not ${withoutCredentials(asked)}.`,
      {
        code: ErrorCode.Usage,
        hint: `Sign in to ${alias} where it is, or declare the new address under another name: \`aireg registry add <address> --as <name>\`.`,
      },
    );
  }
  manifest.registries[alias] = source;
  await writeManifest(user, manifest);
}
