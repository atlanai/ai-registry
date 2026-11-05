import { withAbsolutePath } from "#adapter/index.ts";

// No git:// or http://: neither has transport security, and git follows a redirect to any
// protocol listed.
const ALLOWED_PROTOCOLS = "https:ssh:file";

/** Plain http for a remote that is itself http, which the host allows on loopback alone. */
export function transportEnv(url: string): NodeJS.ProcessEnv {
  return /^http:/i.test(url) ? { GIT_ALLOW_PROTOCOL: `${ALLOWED_PROTOCOLS}:http` } : {};
}

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // A private repository without credentials must fail, not block CI on a prompt, and read-only
  // inspection must not write index.lock beside a concurrent run.
  return withAbsolutePath({
    ...withoutRepository(process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  });
}

/**
 * What `git rev-parse --local-env-vars` lists, less its config entries. Inside a
 * git hook these name the caller's repository, and a clone would write into it.
 */
const REPOSITORY_VARIABLES: readonly string[] = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

/** The caller's environment with nothing that points git at the caller's repository. */
function withoutRepository(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of REPOSITORY_VARIABLES) delete kept[name];
  return kept;
}

/**
 * Files land as committed, so they match the digests the registry states: no LFS filters, even
 * without git-lfs, and no line-ending conversion, which Git for Windows turns on by default.
 */
export const CHECKOUT_CONFIG: readonly string[] = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
];
