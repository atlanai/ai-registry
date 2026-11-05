import { covers } from "#adapter/contract.ts";
import type { Want } from "#adapter/index.ts";
import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import type { Lock, LockArtifact, LockRegistry } from "#core/lock.ts";
import type { Manifest, RegistrySource } from "#core/manifest/model.ts";
import { formatAddress, type Ref } from "#core/ref.ts";
import type { LockView } from "./lock-view.ts";

export interface Locked {
  lock: Lock;
  moving: ReadonlySet<string>;
  held?: boolean;
}

/**
 * Undefined means the registry was never asked for. `all` means a whole
 * registry or namespace, and the named wants still pin what they name.
 */
export function wanted(manifest: Manifest, alias: string): Request | undefined {
  // Keyed by address, so a pin stays on the artifact it was written on.
  const byAddress = new Map<string, Want>();
  let asked = false;
  let all = false;
  for (const ref of manifest.artifacts) {
    if (ref.registry !== alias) continue;
    asked = true;
    const plugin = namespacePlugin(manifest, alias, ref);
    if (plugin !== undefined) {
      byAddress.set(formatAddress(ref), plugin);
      continue;
    }
    if (ref.name === undefined) {
      all = true;
      continue;
    }
    const address = formatAddress(ref);
    const version = ref.version ?? byAddress.get(address)?.version;
    byAddress.set(address, {
      name: ref.name,
      ...(ref.namespace === undefined ? {} : { namespace: ref.namespace }),
      ...(ref.kind === undefined ? {} : { kind: ref.kind }),
      ...(version === undefined ? {} : { version }),
    });
  }
  if (!asked) return undefined;
  const want = [...byAddress.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) => item);
  return { want, all };
}

/**
 * A marketplace files each plugin's parts under the plugin's name, so a namespace there is one
 * plugin, asked for by name rather than by reading every plugin the marketplace lists.
 */
function namespacePlugin(manifest: Manifest, alias: string, ref: Ref): Want | undefined {
  if (ref.name !== undefined || ref.namespace === undefined) return undefined;
  const layout = manifest.registries[alias]?.config.layout;
  return layout === "marketplace" ? { name: ref.namespace, kind: "plugin" } : undefined;
}

/**
 * Locked rows are asked for at their locked version unless moved or pinned, so later publishes wait
 * for `update`; a whole reference reaching no row is new and asks for everything, unless `held`.
 */
export function lockedRequest(
  manifest: Manifest,
  alias: string,
  { lock, moving, held = false }: Locked,
  view: LockView,
): Request | undefined {
  const request = wanted(manifest, alias);
  if (request === undefined) return undefined;
  const pins = request.want.filter((want) => want.version !== undefined);
  const asked = new Map<string, Want>();
  const named = new Set<string>();
  let all = false;
  const source = lock.registries[alias];
  // Read at one commit, a source that is not a registry moves as a whole or not at all; one
  // declared anew, such as at another ref, no longer holds the versions it was locked at.
  const whole =
    isReadOnlyLayout(source?.config.layout) && view.rows(alias).some(([name]) => moving.has(name));
  const redeclared = source !== undefined && !sameDeclaration(manifest.registries[alias], source);
  for (const ref of manifest.artifacts) {
    if (ref.registry !== alias) continue;
    const rows = view.reached(ref);
    for (const name of rows) named.add(name);
    if (ref.name === undefined && !held && rows.every((name) => moving.has(name))) {
      // `wanted` asks for a marketplace's plugin by name, which brings whatever it holds now.
      if (namespacePlugin(manifest, alias, ref) === undefined) all = true;
      continue;
    }
    for (const name of rows) {
      const row = lock.artifacts[name] as LockArtifact;
      const pinned = pins.some((want) => covers(want, row));
      const free = moving.has(name) || pinned || row.version === undefined || whole || redeclared;
      asked.set(name, lockedWant(row, free));
    }
  }
  // A dependency is held at the version its dependents needed; the closure moves it when they do.
  for (const [name, row] of view.rows(alias)) {
    if (row.neededBy === undefined || named.has(name)) continue;
    asked.set(name, {
      name: row.name,
      namespace: row.namespace,
      kind: row.kind,
      ...(row.version === undefined ? {} : { version: row.version }),
    });
  }
  return { want: [...request.want, ...asked.values()], all };
}

function sameDeclaration(declared: RegistrySource | undefined, locked: LockRegistry): boolean {
  return (
    declared !== undefined &&
    declared.location === locked.location &&
    (declared.adapter === undefined || declared.adapter === locked.adapter) &&
    JSON.stringify(declared.config) === JSON.stringify(locked.config)
  );
}

/** A locked row asked for again: at its version and commit, unless it is free to move. */
function lockedWant(row: LockArtifact, free: boolean): Want {
  return {
    name: row.name,
    namespace: row.namespace,
    kind: row.kind,
    ...(free ? {} : { version: row.version }),
    ...(free || row.revision === undefined ? {} : { revision: row.revision }),
  };
}

export interface Request {
  want: Want[];
  all: boolean;
}
