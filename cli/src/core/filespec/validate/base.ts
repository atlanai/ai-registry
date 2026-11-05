import { join, posix } from "node:path";
import { ARTIFACTS_DIR, VERSIONS_DOCUMENT, versionsPath } from "#adapter/filespec/names.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { exists } from "#core/fs/tree.ts";
import { gitIn } from "#core/process.ts";
import { sentence } from "#core/term/printer.ts";
import { type Problem, parsed, readDocument, rowsOf } from "./read.ts";

export async function baseDiff(root: string, base: string): Promise<BaseDiff> {
  // A ref git would read as an option, such as `--output=<file>`, never reaches it.
  if (base.startsWith("-")) {
    throw new AiregError(`--base takes a git ref, not ${quoted(base)}.`, { code: ErrorCode.Usage });
  }
  await fetchIfMissing(root, base);
  const resolved = await gitIn(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${base}^{commit}`,
  ]);
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || commit === "") {
    throw new AiregError(`No commit named ${quoted(base)} to compare with.`, {
      code: ErrorCode.NotFound,
      hint: "Fetch it, or pass another `--base <ref>`.",
    });
  }
  const diff = await gitIn(root, ["diff", "--name-only", commit, "--", ARTIFACTS_DIR]);
  if (diff.code !== 0) {
    throw new AiregError(`Could not compare with ${quoted(base)}: ${sentence(diff.stderr)}`, {
      code: ErrorCode.NotFound,
      hint: "Fetch it, or pass another `--base <ref>`.",
    });
  }
  const shown = await gitIn(root, ["rev-parse", "--show-prefix"]);
  if (shown.code !== 0) {
    throw new AiregError(sentence(shown.stderr), { code: ErrorCode.Unavailable });
  }
  const prefix = shown.stdout.trim();
  const paths = diff.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => (prefix !== "" && line.startsWith(prefix) ? line.slice(prefix.length) : line));
  const cache = new Map<string, Promise<Map<string, unknown>>>();
  const released = (versionsAt: string) => {
    let found = cache.get(versionsAt);
    if (found === undefined) {
      found = gitIn(root, ["show", `${commit}:./${versionsAt}`]).then((before) =>
        before.code === 0 ? rowsOf(parsed(before.stdout)) : new Map(),
      );
      cache.set(versionsAt, found);
    }
    return found;
  };
  return { ref: base, paths, released };
}

interface BaseDiff {
  /** The ref as the author gave it, for the fixes printed. */
  ref: string;
  /** Root-relative, under `artifacts/`. */
  paths: string[];
  /** Each artifact's released versions in the base, by its `versions.json` path. */
  released: (versionsAt: string) => Promise<Map<string, unknown>>;
}

/** A CI checkout holds one commit; the tip of the target branch is all a comparison needs. */
async function fetchIfMissing(root: string, base: string): Promise<void> {
  const found = await gitIn(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", base]);
  if (found.code === 0) return;
  const branch = /^origin\/(.+)$/.exec(base)?.[1];
  if (branch === undefined) return;
  await gitIn(root, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

/** Version folders the base revision already released, which no change may touch. */
export async function releasedChanges(diff: BaseDiff): Promise<Map<string, string[]>> {
  const changed = new Map<string, string[]>();
  for (const path of diff.paths) {
    const parts = path.split("/");
    if (parts.length < 6 || parts[0] !== ARTIFACTS_DIR) continue;
    const folder = parts.slice(0, 5).join("/");
    const [, namespace, kind, name, version] = parts as [string, string, string, string, string];
    if (!(await diff.released(versionsPath(namespace, kind, name))).has(version)) continue;
    changed.set(folder, [...(changed.get(folder) ?? []), path]);
  }
  return changed;
}

/**
 * Rule 1 and rule 7: a `versions.json` may reorder its rows and change their status,
 * but every version the base released stays listed with the digest it was released as.
 */
export async function droppedReleases(root: string, diff: BaseDiff): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const path of diff.paths) {
    const parts = path.split("/");
    if (parts.length !== 5 || parts[0] !== ARTIFACTS_DIR || parts[4] !== VERSIONS_DOCUMENT)
      continue;
    const now = await readDocument(root, path);
    const gone = now === undefined && !(await exists(join(root, ...path.split(posix.sep))));
    if (now === undefined && !gone) continue;
    const listed = rowsOf(now);
    for (const [version, digest] of await diff.released(path)) {
      if (listed.get(version) === digest) continue;
      problems.push({
        path,
        message: gone
          ? `is missing, but ${version} was released`
          : listed.has(version)
            ? `changes the digest of ${version}, which was released as ${String(digest)}`
            : `no longer lists ${version}, which was released`,
        fix: gone ? `git checkout ${diff.ref} -- ${posix.dirname(path)}; ${WITHDRAW}` : undefined,
      });
    }
  }
  return problems;
}

/** Rule 7: nothing is erased, so a release is withdrawn by yanking it. */
const WITHDRAW = 'to withdraw a release, set "yanked": true in its versions.json instead';
