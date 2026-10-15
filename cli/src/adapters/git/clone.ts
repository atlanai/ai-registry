import { rm } from "node:fs/promises";
import { CHECKOUT_CONFIG, gitEnv, transportEnv } from "./env.ts";
import { GitError, type GitLimits, gh, git } from "./exec.ts";
import { SHA } from "./resolve.ts";
import { type Attempt, attempts, describeFailure } from "./transport.ts";
import type { SourceSpec } from "./url.ts";

/** A server on git's dumb http protocol has no history to cut short, so it is cloned whole. */
function cannotShallow(error: unknown): boolean {
  return error instanceof GitError && /does not support shallow/i.test(error.stderr);
}

async function cloneShallow(
  url: string,
  dest: string,
  ref: string | undefined,
  limits: GitLimits,
): Promise<void> {
  const branch = ref === undefined ? [] : ["--branch", ref];
  const run = (depth: readonly string[]) =>
    git(
      [
        ...CHECKOUT_CONFIG,
        "clone",
        ...depth,
        "--no-tags",
        ...branch,
        "--end-of-options",
        url,
        dest,
      ],
      {
        ...limits,
        env: transportEnv(url),
      },
    );
  await run(["--depth", "1"]).catch(async (error: unknown) => {
    if (!cannotShallow(error)) throw error;
    await rm(dest, { recursive: true, force: true });
    await run([]);
  });
}

/** A bare sha is not reachable through `--branch`; fetch it into an empty repo. */
async function cloneCommit(
  url: string,
  dest: string,
  commit: string,
  limits: GitLimits,
): Promise<void> {
  await git([...CHECKOUT_CONFIG, "init", "--quiet", dest], limits);
  await git(["remote", "add", "origin", "--", url], { ...limits, cwd: dest });
  const fetch = (depth: readonly string[]) =>
    git([...CHECKOUT_CONFIG, "fetch", ...depth, "origin", "--end-of-options", commit], {
      ...limits,
      cwd: dest,
      env: transportEnv(url),
    });
  await fetch(["--depth", "1"]).catch((error: unknown) => {
    if (!cannotShallow(error)) throw error;
    return fetch([]);
  });
  await git([...CHECKOUT_CONFIG, "checkout", "--quiet", "FETCH_HEAD"], { ...limits, cwd: dest });
}

async function cloneViaGh(
  slug: string,
  dest: string,
  ref: string | undefined,
  limits: GitLimits,
): Promise<void> {
  // After `--` these go to git clone, whose -c sets them before the checkout.
  const flags = [...CHECKOUT_CONFIG, "--depth=1", ...(ref === undefined ? [] : ["--branch", ref])];
  const { code, stderr } = await gh(["repo", "clone", slug, dest, "--", ...flags], {
    ...limits,
    // gh runs git, which must keep the same protocol and prompt limits.
    env: gitEnv(),
  });
  if (code !== 0) throw new Error(stderr.trim() || `gh repo clone failed with exit code ${code}.`);
}

async function attempt(
  a: Attempt,
  dest: string,
  ref: string | undefined,
  limits: GitLimits,
): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  if (a.viaGh) {
    await cloneViaGh(a.url, dest, ref, limits);
    return;
  }
  if (ref !== undefined && SHA.test(ref)) {
    await cloneCommit(a.url, dest, ref.toLowerCase(), limits);
    return;
  }
  await cloneShallow(a.url, dest, ref, limits);
}

/**
 * A ladder entry that fails for a reason retrying cannot fix - the repository
 * does not exist - ends the walk immediately.
 */
export async function clone(
  spec: SourceSpec,
  ref: string | undefined,
  dest: string,
  limits: GitLimits,
): Promise<void> {
  const ladder = attempts(spec);
  let last: unknown;

  for (const a of ladder) {
    try {
      await attempt(a, dest, ref, limits);
      return;
    } catch (error) {
      last = error;
      if (limits.signal?.aborted === true) break;
      if (error instanceof GitError && error.failure === "not_found") break;
    }
  }

  await rm(dest, { recursive: true, force: true }).catch(() => {});
  throw describeFailure(last, spec, ladder);
}

/** Commit currently checked out; the pin recorded in the lock. */
export async function headCommit(dir: string, limits: GitLimits): Promise<string> {
  return (await git(["rev-parse", "--verify", "HEAD"], { ...limits, cwd: dir })).trim();
}
