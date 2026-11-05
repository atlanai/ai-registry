import { join, posix } from "node:path";
import type { ArtifactKind } from "#adapter/index.ts";
import { subdirectories } from "#core/fs/tree.ts";
import { KIND_SPECS, kindDir, SCANNED_KINDS } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { namespaceDir, type Roots, registryDir } from "#core/store/paths.ts";
import { entriesIn } from "#core/sync/scan.ts";

export interface UnlockedCopy {
  name: string;
  kind: ArtifactKind;
  registry: string;
  namespace: string;
  /** Relative to the namespace directory, POSIX separators. */
  path: string;
}

/**
 * Content in the writable copy that neither the lock nor the catalog claims, read
 * with the same rules `candidates()` applies, so a stray directory is not publishable.
 */
export async function unlockedCopies(
  manifest: Manifest,
  lock: Lock,
  roots: Pick<Roots, "artifacts">,
): Promise<UnlockedCopy[]> {
  const claimed = new Set<string>();
  for (const [name, entry] of Object.entries(lock.artifacts)) {
    claimed.add(`${entry.registry}\u0000${entry.kind}:${entry.name}`);
    claimed.add(`${entry.registry}\u0000${entry.kind}:${name}`);
  }

  // A plugin's copy, a folder named after it, holds its parts, which its own row accounts for.
  const plugins = new Set(
    Object.values(lock.artifacts).flatMap((entry) =>
      entry.kind === "plugin" ? [`${entry.registry}\u0000${posix.basename(entry.path)}`] : [],
    ),
  );
  const found: UnlockedCopy[] = [];
  for (const registry of Object.keys(manifest.registries)) {
    for (const namespace of await subdirectories(registryDir(roots, registry))) {
      if (plugins.has(`${registry}\u0000${namespace}`)) continue;
      const base = namespaceDir(roots, registry, namespace);
      for (const kind of SCANNED_KINDS) {
        const spec = KIND_SPECS[kind];
        const entries = await entriesIn(
          base,
          join(base, kindDir(kind)),
          {
            kind,
            shape: spec.shape,
            extensions: spec.extensions,
            ...(spec.entry === undefined ? {} : { entry: spec.entry }),
          },
          namespace,
        );
        for (const entry of entries) {
          if (claimed.has(`${registry}\u0000${kind}:${entry.name}`)) continue;
          found.push({ name: entry.name, kind, registry, namespace, path: entry.path });
        }
      }
    }
  }
  return found.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
}
