import { rm } from "node:fs/promises";
import { CHECKOUT_CONFIG, transportEnv } from "./env.ts";
import { GitError, type GitLimits, git } from "./exec.ts";
import { SHA } from "./resolve.ts";
import { type Attempt, overLadder } from "./transport.ts";
import type { SourceSpec } from "./url.ts";

export async function clone(
  spec: SourceSpec,
  ref: string | undefined,
  dest: string,
  limits: GitLimits,
): Promise<void> {
  try {
    await overLadder(spec, limits, (a) => attempt(a, dest, ref, limits));
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function attempt(
  a: Attempt,
  dest: string,
  ref: string | undefined,
  limits: GitLimits,
): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  if (ref !== undefined && SHA.test(ref)) {
    await cloneCommit(a, dest, ref.toLowerCase(), limits);
    return;
  }
  await cloneShallow(a, dest, ref, limits);
}

/** A bare sha is not reachable through `--branch`; fetch it into an empty repo. */
async function cloneCommit(
  { url, config }: Attempt,
  dest: string,
  commit: string,
  limits: GitLimits,
): Promise<void> {
  await git([...CHECKOUT_CONFIG, "init", "--quiet", dest], limits);
  await git(["remote", "add", "origin", "--", url], { ...limits, cwd: dest });
  const fetch = (depth: readonly string[]) =>
    git([...CHECKOUT_CONFIG, ...config, "fetch", ...depth, "origin", "--end-of-options", commit], {
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

/** A server on git's dumb http protocol has no history to cut short, so it is cloned whole. */
function cannotShallow(error: unknown): boolean {
  return error instanceof GitError && /does not support shallow/i.test(error.stderr);
}

async function cloneShallow(
  { url, config }: Attempt,
  dest: string,
  ref: string | undefined,
  limits: GitLimits,
): Promise<void> {
  const branch = ref === undefined ? [] : ["--branch", ref];
  const run = (depth: readonly string[]) =>
    git(
      [
        ...CHECKOUT_CONFIG,
        ...config,
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

/** Commit currently checked out; the pin recorded in the lock. */
export async function headCommit(dir: string, limits: GitLimits): Promise<string> {
  return (await git(["rev-parse", "--verify", "HEAD"], { ...limits, cwd: dir })).trim();
}
