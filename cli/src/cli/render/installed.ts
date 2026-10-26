import { shownNames } from "#cli/names.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { asksFor, type Manifest, pinOf } from "#core/manifest.ts";
import { abbreviate, type Printer } from "#core/output.ts";
import { type Scope, scopeName } from "#core/store/paths.ts";
import { earlierId, type Targets } from "#core/target/index.ts";
import type { Column } from "#core/term/table.ts";

export interface Installed {
  name: string;
  /** The shortest name no other artifact here shares, which tables show. */
  shown: string;
  kind: string;
  registry: string;
  address: string;
  ref: string;
  pinned: boolean;
  targets: string[];
  watched?: Watched | undefined;
  /** What it is installed for, when the manifest does not ask for it itself. */
  neededBy?: string[] | undefined;
}

/** The folder a watched row is published from, where its target reads it; nothing is linked. */
export interface Watched {
  target: string;
  /** `target` by its aireg 0.1 id, under the key that version printed. */
  harness: string;
  path: string;
}

export function watchedFrom(
  entry: LockArtifact | undefined,
  targetTable: Targets,
): Watched | undefined {
  if (entry?.origin === undefined) return undefined;
  const { target, path } = entry.origin;
  return { target, harness: earlierId(targetTable, target), path };
}

export function installed(lock: Lock, manifest: Manifest, targetTable: Targets): Installed[] {
  const shown = shownNames(lock);
  return Object.keys(lock.artifacts)
    .sort()
    .map((name) => {
      const entry = lock.artifacts[name];
      const source = entry === undefined ? undefined : lock.registries[entry.registry];
      return {
        name,
        shown: shown.get(name) ?? name,
        kind: entry?.kind ?? "",
        registry: entry?.registry ?? "",
        address: source?.location ?? "",
        // A row of yours has a version once a publish of it is recorded, and a commit sha
        // identifies the registry rather than the artifact.
        ref:
          entry?.version ??
          (entry?.origin !== undefined || source?.revision === undefined
            ? ""
            : abbreviate(source.revision)),
        pinned: entry !== undefined && pinOf(manifest, entry) !== undefined,
        // One target, however many links it took to reach it: a target that loads plugins
        // gets a link inside the projection as well as the one pointing at it.
        targets: [...new Set((entry?.links ?? []).map((link) => link.target))].sort(),
        watched: watchedFrom(entry, targetTable),
        neededBy:
          entry === undefined || asksFor(manifest, entry)
            ? undefined
            : entry.neededBy?.map((by) => shown.get(by) ?? by),
      };
    });
}

/** What an installed artifact is and where it came from, the same in every listing. */
export function identity<R>(printer: Printer, of: (row: R) => Installed): Column<R>[] {
  const { style } = printer;
  return [
    { header: "artifact", value: (row) => of(row).shown },
    { header: "kind", value: (row) => style.dim(of(row).kind) },
    {
      header: "version",
      value: (row) => {
        const item = of(row);
        return item.pinned ? `${item.ref} ${style.yellow("pinned")}` : item.ref;
      },
    },
    { header: "from", value: (row) => of(row).registry },
    {
      header: "needed by",
      value: (row) => style.dim(of(row).neededBy?.join(", ") ?? ""),
      optional: true,
    },
  ];
}

export function heading(printer: Printer, count: number, scope: Scope): void {
  printer.info(printer.style.bold(`${count} installed in ${scopeName(scope)}`));
}
