import { compareVersion, parseVersion } from "#adapter/semver.ts";
import type { LockArtifact } from "#core/lock.ts";
import { listedAt } from "#core/plan/acquire/sources.ts";
import type { Placement } from "#core/plan/model.ts";
import type { Scan } from "./scan.ts";

/**
 * A backend may hold an upload for review. Until upstream serves something else, restating
 * the row from it would overwrite the copy just sent, or delete it when nothing is served.
 */
export function moved(
  found: Scan,
  entry: LockArtifact | undefined,
  /** The version just sent; an older head is someone else's, as after `--force` into a clone. */
  sent?: string,
): boolean {
  const now = entry === undefined ? undefined : head(found, entry);
  return (
    entry !== undefined &&
    now !== undefined &&
    (now.contentId !== entry.content || now.version !== entry.version) &&
    !older(now.version, sent)
  );
}

/** What the registry serves at the row's address now. */
function head(found: Scan, entry: LockArtifact): Placement | undefined {
  const acquired = found.acquired.find((item) => item.alias === entry.registry);
  const at = acquired === undefined ? undefined : listedAt(entry, acquired.catalog.entries);
  return at === undefined ? undefined : acquired?.placements.get(at);
}

function older(served: string | undefined, sent: string | undefined): boolean {
  const left = served === undefined ? undefined : parseVersion(served);
  const right = sent === undefined ? undefined : parseVersion(sent);
  return left !== undefined && right !== undefined && compareVersion(left, right) < 0;
}

/** Said of a published row the manifest pins, so the lock keeps it where it was. */
export function pinnedNote(row: string, pinned: string, sent: string | undefined): string {
  const to = sent === undefined ? "" : ` to ${sent}`;
  return `${row} stays at ${pinned} here because the manifest pins it. Change the pin${to} to install what you published.`;
}

/** Said of a published row the registry does not serve at what was sent, so its copy stays. */
export function unservedNote(
  found: Scan,
  entry: LockArtifact,
  row: string,
  sent: string | undefined,
): { message: string; warning: boolean } {
  const next = entry.origin === undefined ? "`aireg update`" : "`aireg sync`";
  // Moved past the lock but not to what was sent, as after `--force` into a clone.
  const other = moved(found, entry) ? head(found, entry)?.version : undefined;
  if (other === undefined) {
    return {
      message: `The registry does not serve ${row} yet, so the copy here was left as it is. Run ${next} once it does.`,
      warning: false,
    };
  }
  return {
    message: `The registry serves ${row} ${other}, not the ${sent} you published, so the copy here was left as it is. Run ${next} once it serves ${sent}; before that it would replace your copy with ${other}.`,
    warning: true,
  };
}
