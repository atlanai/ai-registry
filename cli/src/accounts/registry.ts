import type { SourceAdapter } from "#adapter/index.ts";
import { withoutCredentials } from "#adapter/text.ts";
import { comparableLocation, sourceKey } from "#core/adapter/identity.ts";
import { adapterFor, declaredLayout } from "#core/adapter/load.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import type { Manifest, RegistrySource } from "#core/manifest/model.ts";
import { readManifest, writeManifest } from "#core/manifest/repository.ts";
import { roots, type Scope } from "#core/store/paths.ts";

export interface ResolvedRegistry {
  alias: string;
  source: RegistrySource;
  /** A local path is made absolute against the caller's `cwd`; a URL is kept as written. */
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

function declaredIn(manifest: Manifest, alias: string, scope: Scope): RegistrySource {
  const source = manifest.registries[alias];
  if (source === undefined) throw unknownRegistry(alias, scope, Object.keys(manifest.registries));
  return source;
}

/** The user scope's declaration of `alias`, refused when it is somewhere other than `location`. */
export function heldAt(
  registries: Readonly<Record<string, RegistrySource>>,
  alias: string,
  location: string,
  cwd: string,
): RegistrySource | undefined {
  const held = registries[alias];
  if (held === undefined) return undefined;
  const theirs = expandLocation(held.location, cwd);
  const asked = expandLocation(location, cwd);
  if (comparableLocation(theirs) === comparableLocation(asked)) return held;
  throw new AiregError(
    `${alias} is ${withoutCredentials(theirs)} in your user scope, not ${withoutCredentials(asked)}.`,
    {
      code: ErrorCode.Usage,
      hint: `Sign in to ${alias} where it is, or declare the new address under another name: \`aireg registry add <address> --as <name>\`.`,
    },
  );
}

/**
 * Declares `alias` in the user scope for a sign-in that names its address. A name declared at
 * another address is refused, so a sign-in never reaches the one not named.
 */
export async function declareRegistryFor(alias: string, source: RegistrySource): Promise<void> {
  const cwd = process.cwd();
  const user = roots("user", cwd);
  const manifest = await readManifest(user.manifest);
  if (heldAt(manifest.registries, alias, source.location, cwd) !== undefined) return;
  manifest.registries[alias] = source;
  await writeManifest(user, manifest);
}
