import { sanitizeName } from "#adapter/text.ts";
import { formatAddress, type Ref, relativeTo } from "#core/ref.ts";
import type { Manifest } from "./model.ts";

/** The `artifacts:` entry a remote dependency names: the same address, at any exact version. */
export function artifactFor(artifacts: readonly Ref[], ref: Ref): Ref | undefined {
  const address = formatAddress(ref);
  return artifacts.find((entry) => formatAddress(entry) === address);
}

/** The artifact a lock row installed, as far as a manifest pin can name it. */
export interface Pinnable {
  registry: string;
  name: string;
  kind: string;
  namespace: string | undefined;
}

/**
 * The version the manifest holds an installed artifact at, matched by address:
 * a namespace install names the row `platform/lint`, the pin says `lint@1.0.0`.
 */
export function pinOf(manifest: Manifest, row: Pinnable): string | undefined {
  for (const ref of manifest.artifacts) {
    if (ref.version === undefined || ref.registry !== row.registry) continue;
    if (ref.name !== row.name || (ref.kind !== undefined && ref.kind !== row.kind)) continue;
    if (ref.namespace !== undefined && ref.namespace !== row.namespace) continue;
    return ref.version;
  }
  return undefined;
}

/** Whether a manifest ref reaches one installed row: by address, never by display name. */
export function reaches(ref: Ref, row: Pinnable): boolean {
  if (row.registry !== ref.registry) return false;
  if (ref.namespace !== undefined && row.namespace !== sanitizeName(ref.namespace)) return false;
  if (ref.kind !== undefined && row.kind !== ref.kind) return false;
  return ref.name === undefined || sanitizeName(row.name) === sanitizeName(ref.name);
}

/** One artifact named on its own adds nothing when a whole namespace or registry entry already takes it. */
export function coveredByWhole(ref: Ref, artifacts: readonly Ref[]): boolean {
  if (ref.name === undefined || ref.kind === undefined) return false;
  if (ref.version !== undefined || ref.localName !== undefined) {
    return false;
  }
  if (ref.targets !== undefined || ref.copy === true) return false;
  return artifacts.some(
    (whole) =>
      whole.name === undefined &&
      whole.registry === ref.registry &&
      (whole.namespace === undefined || whole.namespace === ref.namespace) &&
      whole.targets === undefined &&
      whole.copy !== true &&
      !(whole.exclude ?? []).includes(
        relativeTo(whole, {
          namespace: ref.namespace,
          kind: ref.kind as string,
          name: sanitizeName(ref.name as string),
        }),
      ),
  );
}

/** The manifest entries that ask for this row, leaving out any that exclude it. */
export function askingFor(manifest: Manifest, row: Pinnable): Ref[] {
  return manifest.artifacts.filter(
    (ref) =>
      reaches(ref, row) &&
      !(ref.exclude ?? []).includes(
        relativeTo(ref, { namespace: row.namespace, kind: row.kind, name: sanitizeName(row.name) }),
      ),
  );
}

/** Whether the manifest asks for this row itself, rather than for something that needs it. */
export function asksFor(manifest: Manifest, row: Pinnable): boolean {
  return askingFor(manifest, row).length > 0;
}
