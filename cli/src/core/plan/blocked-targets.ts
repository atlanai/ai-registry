import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isAbsent } from "#adapter/files.ts";
import type { Plan } from "./model.ts";

/** A target a plan would write into, and the directory that would refuse it. */
export interface BlockedTarget {
  /** Target table id, such as `cursor`. */
  target: string;
  /** The nearest existing directory above the link, which is what refuses. */
  path: string;
}

/**
 * The targets a plan cannot be applied into. `apply` creates each link's
 * parent as it goes, so an unwritable root fails partway on a bare errno.
 */
export async function blockedTargets(plan: Plan): Promise<BlockedTarget[]> {
  const blocked = new Map<string, BlockedTarget>();
  for (const action of plan.actions) {
    if (action.kind !== "link" || blocked.has(action.target)) continue;
    const ancestor = await existingAncestor(dirname(action.to));
    if (ancestor === undefined || (await writable(ancestor))) continue;
    blocked.set(action.target, { target: action.target, path: ancestor });
  }
  return [...blocked.values()].sort((left, right) => left.target.localeCompare(right.target));
}

/**
 * The nearest ancestor that exists, which is where `mkdir -p` would first be
 * asked to create a child.
 */
async function existingAncestor(path: string): Promise<string | undefined> {
  let current = path;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      // An ancestor that is a file is found by walking up, like one not there yet.
      if (!isAbsent(error)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A path that exists, is a directory, and can be written into. */
async function writable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false;
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
