import { quoted } from "#adapter/index.ts";
import { transportEnv } from "./env.ts";
import { GitError, type GitLimits, git } from "./exec.ts";
import { overLadder } from "./transport.ts";
import type { SourceSpec } from "./url.ts";

export interface ResolvedRef {
  /** What was asked for; undefined means the remote's default branch. */
  ref: string | undefined;
  refKind: "tag" | "branch" | "sha";
  commit: string;
}

export const SHA = /^[0-9a-f]{40}$/i;

export interface RemoteRef {
  commit: string;
  name: string;
}

/**
 * Walks the same transport ladder as the clone. Resolving over HTTPS while
 * cloning over SSH would fail a private repository before the fallback ran.
 */
export async function lsRemote(
  spec: SourceSpec,
  patterns: string[],
  limits: GitLimits,
): Promise<RemoteRef[]> {
  const out = await overLadder(spec, limits, (attempt) =>
    git([...attempt.config, "ls-remote", "--", attempt.url, ...patterns], {
      ...limits,
      env: transportEnv(attempt.url),
    }),
  );

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [commit = "", name = ""] = line.split(/\s+/, 2);
      return { commit, name };
    })
    .filter((entry) => entry.commit !== "");
}

/**
 * `ls-remote` lists an annotated tag's own object and the commit it points at,
 * as `<ref>^{}`. Everything downstream keys on the commit, so the peel wins.
 */
export function peel(refs: readonly RemoteRef[], name: string): RemoteRef | undefined {
  const peeled = refs.find((entry) => entry.name === `${name}^{}`);
  if (peeled !== undefined) return peeled;
  return refs.find((entry) => entry.name === name);
}

/**
 * A ref that is both a tag and a branch is an error rather than a guess: git's
 * own precedence would silently pick one.
 */
export async function resolveRef(
  spec: SourceSpec,
  ref: string | undefined,
  limits: GitLimits,
): Promise<ResolvedRef> {
  if (ref !== undefined && SHA.test(ref)) {
    return { ref, refKind: "sha", commit: ref.toLowerCase() };
  }

  if (ref === undefined) {
    const head = await lsRemote(spec, ["HEAD"], limits);
    const commit = peel(head, "HEAD")?.commit;
    if (commit === undefined) {
      throw new GitError("not_found", `${spec.location} has no default branch.`);
    }
    return { ref: undefined, refKind: "branch", commit };
  }

  // The peeled pattern has to be asked for by name: with an explicit refspec
  // `ls-remote` lists only what was named.
  const found = await lsRemote(
    spec,
    [`refs/tags/${ref}`, `refs/tags/${ref}^{}`, `refs/heads/${ref}`],
    limits,
  );
  const tag = peel(found, `refs/tags/${ref}`);
  const branch = peel(found, `refs/heads/${ref}`);

  if (tag !== undefined && branch !== undefined && tag.commit !== branch.commit) {
    throw new GitError(
      "invalid",
      `${quoted(ref)} is both a tag and a branch in ${spec.location}, at different commits.`,
      { hint: `Name one: \`refs/tags/${ref}\` or \`refs/heads/${ref}\`.` },
    );
  }

  const chosen = tag ?? branch;
  if (chosen === undefined) {
    throw new GitError("not_found", `${spec.location} has no tag or branch named ${quoted(ref)}.`);
  }
  return { ref, refKind: tag !== undefined ? "tag" : "branch", commit: chosen.commit };
}
