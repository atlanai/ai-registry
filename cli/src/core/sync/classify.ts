import type { Digests, Disposition } from "./model.ts";

export interface Classified {
  disposition: Disposition;
  detail: string | undefined;
}

/** Content, never history: the same edit on both sides, or an undone edit, is `synced`. */
export function classify(digests: Digests): Classified {
  const { base, local, upstream } = digests;

  if (local !== undefined && local === upstream) {
    return { disposition: "synced", detail: undefined };
  }

  if (base === undefined || base === "") {
    if (local === undefined && upstream !== undefined) {
      return { disposition: "pull", detail: "new in the registry" };
    }
    if (local !== undefined && upstream === undefined) {
      return { disposition: "adopt", detail: "written here and published nowhere" };
    }
    return {
      disposition: "unknown",
      detail: "the lockfile records no digest for what was installed",
    };
  }

  if (local === undefined && upstream === undefined) {
    return { disposition: "removed", detail: "deleted here and in the registry" };
  }
  if (local === undefined) {
    return upstream === base
      ? { disposition: "archive", detail: "deleted here" }
      : { disposition: "conflict", detail: "deleted here and changed in the registry" };
  }
  if (upstream === undefined) {
    return local === base
      ? { disposition: "pull-delete", detail: "deleted from the registry" }
      : { disposition: "conflict", detail: "edited here and deleted from the registry" };
  }

  const editedHere = local !== base;
  const movedUpstream = upstream !== base;

  // Never merged: a guessed combination corrupts an artifact yet looks like a successful update.
  if (editedHere && movedUpstream) {
    return { disposition: "conflict", detail: "edited here and changed in the registry" };
  }
  if (editedHere) return { disposition: "publish", detail: "edited here" };
  if (movedUpstream) return { disposition: "pull", detail: "changed in the registry" };

  // Only reached when the lock disagrees with the disk it describes.
  return {
    disposition: "unknown",
    detail: "the lockfile digest matches neither this project nor the registry",
  };
}
