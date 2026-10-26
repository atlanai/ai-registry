import { resolve } from "node:path";
import { quoted, sanitizeText } from "#adapter/text.ts";
import type { LockArtifact } from "#core/lock.ts";
import { editedAnywhere } from "#core/plan/model.ts";
import { removal } from "#core/plan/removable.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";
import { keep } from "./carry.ts";
import type { BuildState } from "./state.ts";

/** Every removal the lock asks for passes here: the lock is a file a repository can ship. */
function unlink(
  build: BuildState,
  name: string,
  to: string,
  how: { edited?: boolean; link?: LockArtifact["links"][number] } = {},
): boolean {
  const verdict = removal(to, build.options.roots);
  if (verdict.how === "refuse") {
    build.warnings.push({
      name,
      message: `Did not remove ${sanitizeText(to)}: the lockfile records it, but ${sanitizeText(verdict.reason)}.`,
    });
    return false;
  }
  build.unlinks.push({
    kind: "unlink",
    name,
    to,
    ...(how.edited === true ? { edited: true } : {}),
    ...(how.link === undefined ? {} : { link: { target: how.link.target, mode: how.link.mode } }),
  });
  return true;
}

/** A target link the lock recorded, which apply takes back only if it is still ours. */
export function unlinkRecorded(
  build: BuildState,
  name: string,
  link: LockArtifact["links"][number],
): boolean {
  return unlink(build, name, resolve(build.options.roots.base, link.path), { link });
}

/** Removes the rows the plan no longer holds, keeping an edited copy and a row of yours. */
export function removeStale(build: BuildState): void {
  for (const [name, entry] of Object.entries(build.lock.artifacts)) {
    if (build.next.artifacts[name] !== undefined) continue;
    // A row with an origin is yours: the manifest never names it, so a plan built from the
    // manifest carries it through, but takes back the links an install gave it.
    if (entry.origin !== undefined) {
      for (const link of entry.links) unlinkRecorded(build, name, link);
      keep(build, name, { ...entry, links: [] });
      continue;
    }
    const state = build.survey.artifacts[name];
    const edited = editedAnywhere(entry, state);
    if (edited && !build.options.force && build.options.discard?.has(name) !== true) {
      // Kept with its source: a lock row whose registry is gone is dropped on
      // read, and the files would be left with nothing to manage them.
      keep(build, name, { ...entry, neededBy: undefined });
      const source = build.lock.registries[entry.registry];
      if (source !== undefined) build.next.registries[entry.registry] ??= source;
      build.warnings.push({
        name,
        message: `${quoted(name)} was edited after installation, so it was kept although nothing here needs it any more.`,
        hint: `Run \`aireg remove ${name} --force\` to delete it.`,
      });
      continue;
    }
    if (entry.neededBy !== undefined) build.pruned.push(name);
    for (const link of entry.links) unlinkRecorded(build, name, link);
    unlink(
      build,
      name,
      artifactPath(
        build.options.roots,
        entry.registry,
        entry.namespace,
        entry.kind,
        copyLeaf(name, entry.name),
        entry.path,
      ),
      { edited },
    );
    // Nothing is removed from the mirror: it is shared by every scope, so only a
    // sweep that reads every lock could tell a version nothing references.
  }
}

/**
 * Plans the removals held back, once every link is known: none the new plan claims again,
 * and none at a path a row this run did not read still records.
 */
export function flushUnlinks(build: BuildState, held: readonly [string, LockArtifact][]): void {
  const { base } = build.options.roots;
  const seen = new Set(
    held.flatMap(([, entry]) => entry.links.map((link) => resolve(base, link.path))),
  );
  for (const action of build.unlinks) {
    if (build.claimed.has(action.to) || seen.has(action.to)) continue;
    seen.add(action.to);
    build.actions.push(action);
  }
}
