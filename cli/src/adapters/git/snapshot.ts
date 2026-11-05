import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeName, sha256 } from "#adapter/index.ts";
import { clone, headCommit } from "./clone.ts";
import { fail } from "./errors.ts";
import type { GitLimits } from "./exec.ts";
import type { SourceSpec } from "./url.ts";

export interface Snapshot {
  /** Directory holding the repository contents at `commit`. */
  root: string;
  commit: string | undefined;
  /** False when this run had to clone. */
  cached: boolean;
}

/** Keeps a checkout from being pruned until the connection reading it lets go. */
export function holdSnapshot(root: string): () => void {
  IN_USE.set(root, (IN_USE.get(root) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (IN_USE.get(root) ?? 1) - 1;
    if (left <= 0) IN_USE.delete(root);
    else IN_USE.set(root, left);
  };
}

/** Checkouts kept per repository: the latest and the one before, which a run may still read. */
const KEPT_PER_REPOSITORY = 2;

/** Checkouts an open connection in this process still reads, which no prune removes. */
const IN_USE = new Map<string, number>();

/**
 * A local registry is read where it lies: copying it into the store would
 * mean edits to the directory a person is authoring in never take effect.
 */
export async function snapshot(
  cache: () => string,
  spec: SourceSpec,
  ref: string | undefined,
  commit: string | undefined,
  limits: GitLimits,
): Promise<Snapshot> {
  if (spec.kind === "path") return { root: spec.location, commit: undefined, cached: true };

  if (commit !== undefined) {
    const cached = snapshotPath(cache(), spec, commit);
    if (existsSync(cached)) return { root: cached, commit, cached: true };
  }

  const staging = await mkdtemp(join(tmpdir(), "aireg-stage-"));
  const work = join(staging, "repo");
  try {
    await clone(spec, commit ?? ref, work, limits);
    const head = await headCommit(work, limits);
    // Whatever transport answered, what is pinned must be what was resolved.
    if (commit !== undefined && head !== commit.toLowerCase()) {
      throw fail(
        "invalid",
        `${spec.location} gave ${head}, not the commit ${commit} it resolved to.`,
      );
    }
    const final = snapshotPath(cache(), spec, head);

    // A concurrent run may have finished first; its copy is identical.
    if (existsSync(final)) return { root: final, commit: head, cached: true };

    await mkdir(dirname(final), { recursive: true });
    try {
      await rename(work, final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(work, final, { recursive: true });
    }
    await pruneOlder(dirname(final), head);
    return { root: final, commit: head, cached: false };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Keyed by repository and commit, because for git the commit already is the
 * content address. Shared, so two aliases for one repository clone it once.
 */
function snapshotPath(cache: string, spec: SourceSpec, commit: string): string {
  const segments =
    spec.host !== undefined && spec.slug !== undefined
      ? [sanitizeName(spec.host), ...spec.slug.split("/").map(sanitizeName)]
      : [`${sanitizeName(spec.alias)}-${sha256(spec.location).slice(7, 15)}`];
  return join(cache, ...segments, commit);
}

/** Every commit of a busy registry would otherwise stay checked out for good. */
async function pruneOlder(repository: string, current: string): Promise<void> {
  const commits = await readdir(repository, { withFileTypes: true }).catch(() => []);
  const dated = await Promise.all(
    commits
      .filter((entry) => entry.isDirectory() && entry.name !== current)
      .filter((entry) => !IN_USE.has(join(repository, entry.name)))
      .map(async (entry) => {
        const path = join(repository, entry.name);
        return { path, at: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 };
      }),
  );
  const older = dated.sort((left, right) => right.at - left.at).slice(KEPT_PER_REPOSITORY - 1);
  for (const { path } of older) await rm(path, { recursive: true, force: true }).catch(() => {});
}
