import { plural } from "#adapter/text.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Candidate } from "#core/sync/adopt.ts";
import { displayPath } from "#core/sync/adopt.ts";
import type { Disposition, SyncItem } from "#core/sync/model.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";

/** One verb per disposition, in the direction bytes would move. */
const MARK: Record<Disposition, (printer: Printer) => string> = {
  synced: (p) => p.style.green("synced"),
  pull: (p) => p.style.cyan("pull"),
  "pull-delete": (p) => p.style.cyan("remove"),
  publish: (p) => p.style.yellow("publish"),
  conflict: (p) => p.style.red("conflict"),
  adopt: (p) => p.style.yellow("adopt"),
  archive: (p) => p.style.yellow("archive"),
  removed: (p) => p.style.cyan("remove"),
  unknown: (p) => p.style.red("unknown"),
  unavailable: (p) => p.style.red("unavailable"),
};

export function renderSync(
  printer: Printer,
  items: readonly SyncItem[],
  found: readonly Candidate[],
  undeclared: readonly Candidate[],
  roots: Roots,
  /** Undeclared copies holding the registry's bytes, and ones someone changed. */
  claims: {
    linkable: readonly Candidate[];
    changed: readonly Candidate[];
    /** Folders of yours the registry also serves, kept in place with its copy left out. */
    kept?: readonly Candidate[];
  } = {
    linkable: [],
    changed: [],
  },
  /** The one registry the run covers, when it was named. */
  registry?: string,
): void {
  const shown = items.filter((item) => item.disposition !== "synced");

  if (
    shown.length === 0 &&
    found.length === 0 &&
    undeclared.length === 0 &&
    claims.linkable.length === 0 &&
    claims.changed.length === 0 &&
    (claims.kept?.length ?? 0) === 0
  ) {
    const count = items.length;
    printer.info(
      printer.style.dim(
        count === 0
          ? "Nothing is installed."
          : `In sync with ${registry ?? "every registry"} (${plural(count, "artifact")}).`,
      ),
    );
    return;
  }

  if (shown.length > 0) {
    table(
      printer,
      [
        { header: "action", value: (item: SyncItem) => MARK[item.disposition](printer) },
        { header: "artifact", value: (item: SyncItem) => item.name },
        {
          header: "detail",
          value: (item: SyncItem) => printer.style.dim(item.detail ?? ""),
          optional: true,
        },
      ],
      shown,
    );
  }

  if (found.length > 0)
    candidates(printer, "Written here, published nowhere", "adopt", found, roots);
  if (claims.linkable.length > 0) {
    candidates(printer, "Already in the registry, will be managed", "link", claims.linkable, roots);
  }
  if (claims.changed.length > 0) {
    candidates(printer, "Changed here and in the registry", "conflict", claims.changed, roots);
  }
  if (claims.kept !== undefined && claims.kept.length > 0) {
    candidates(printer, "Kept as yours, without the registry copy", "keep", claims.kept, roots);
  }
  if (undeclared.length > 0) {
    candidates(printer, "Already published, not declared here", "declare", undeclared, roots);
  }
}

/** Written or published elsewhere: what it is, and the folder it is in. */
function candidates(
  printer: Printer,
  title: string,
  action: string,
  items: readonly Candidate[],
  roots: Roots,
): void {
  printer.info();
  printer.info(printer.style.bold(title));
  table(
    printer,
    [
      { header: "action", value: () => printer.style.yellow(action) },
      { header: "artifact", value: (item: Candidate) => item.name },
      { header: "kind", value: (item: Candidate) => printer.style.dim(item.kind) },
      {
        header: "folder",
        value: (item: Candidate) => printer.style.dim(displayPath(roots, item.from)),
      },
    ],
    items,
  );
}
