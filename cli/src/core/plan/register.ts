import { dirname, resolve } from "node:path";
import type { Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/index.ts";
import { applyRegister, type Kept, type Touched } from "#core/target/register/index.ts";
import type { Action } from "./model.ts";

/**
 * Edits the configs of targets that load a placement only once they list it,
 * for the links this apply made or removed. Returns the entries it left to a person.
 */
export async function applyRegistrations(
  actions: readonly Action[],
  roots: Pick<Roots, "artifacts" | "base" | "scope" | "cwd">,
  lock: Lock | undefined,
): Promise<Kept[]> {
  const touched = actions.flatMap((action): Touched[] => {
    if (action.kind === "link") return [{ path: action.to, target: action.target }];
    if (action.kind === "unlink") {
      return [{ path: action.to, target: undefined, recorded: action.link?.target }];
    }
    return [];
  });
  if (touched.length === 0) return [];
  // A copy is a real folder, so only the lockfile says it is ours.
  const copies = new Set(
    Object.values(lock?.artifacts ?? {}).flatMap((row) =>
      row.links
        .filter((link) => link.mode === "copy")
        .map((link) => resolve(roots.base, link.path)),
    ),
  );
  const where = { scope: roots.scope, cwd: roots.cwd };
  return applyRegister(touched, resolveTargets(), where, resolve(dirname(roots.artifacts)), copies);
}
