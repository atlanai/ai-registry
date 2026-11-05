import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { homeDir } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import {
  MANIFEST_FILE,
  roots as makeRoots,
  type Roots,
  SCOPE_DIR,
  type Scope,
  userScopeDir,
} from "#core/store/paths.ts";
import type { CommonOptions } from "#engine/options.ts";

/** Where a command acts: its scope, and the directory that scope is rooted at. */
export interface Located {
  scope: Scope;
  base: string;
}

/** What a command does outside any project when no scope was named. */
export type Outside = "user" | "fail";

/** The closest folder holding a `.registry/` manifest or `.git`, as git finds its repository. */
export function locate(explicit: Scope | undefined, cwd: string): Located | undefined {
  if (explicit === "user") return { scope: "user", base: cwd };
  const project = projectRoot(cwd);
  if (project !== undefined) return { scope: explicit ?? "project", base: project };
  return explicit === undefined ? undefined : { scope: explicit, base: cwd };
}

function projectRoot(cwd: string): string | undefined {
  const user = userScopeDir();
  const home = homeDir();
  let dir = cwd;
  for (;;) {
    const own = join(dir, SCOPE_DIR);
    // Home's `.registry/` is a user scope even when AIREG_USER_SCOPE points elsewhere, so it
    // never makes home a project.
    const manifest = existsSync(join(own, MANIFEST_FILE)) && canonical(dir) !== home;
    const marked = manifest || existsSync(join(dir, ".git"));
    if (marked && canonical(own) !== user) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveScope(
  explicit: Scope | undefined,
  cwd: string,
  outside: Outside = "fail",
): Located {
  const located = locate(explicit, cwd);
  if (located !== undefined) return located;
  if (outside === "user") return { scope: "user", base: cwd };
  throw new AiregError("Not in a project.", {
    code: ErrorCode.Usage,
    hint: "Run it inside a repository, or pass `-g` for your user scope.",
  });
}

export function scopeRoots(common: CommonOptions, cwd: string, outside: Outside = "fail"): Roots {
  const { scope, base } = resolveScope(common.scope, cwd, outside);
  return makeRoots(scope, base);
}
