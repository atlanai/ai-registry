import { onPath } from "#adapter/index.ts";
import { GitError } from "./exec.ts";
import { type SourceSpec, sshUrl } from "./url.ts";

export interface Attempt {
  label: "https" | "gh" | "ssh" | "direct";
  url: string;
  /** True when the clone runs through `gh`, which knows the org's SSO state. */
  viaGh: boolean;
}

/**
 * The ladder as an ordered list rather than nested try/catch: adding a
 * transport is appending a row, and the code that walks it never changes.
 */
export function attempts(spec: SourceSpec, env: NodeJS.ProcessEnv = process.env): Attempt[] {
  if (spec.kind === "path") return [{ label: "direct", url: spec.location, viaGh: false }];

  const ssh = sshUrl(spec);
  const isSsh = /^[\w.-]+@[\w.-]+:(?!\/)/.test(spec.location) || spec.location.startsWith("ssh://");
  // Another transport rebuilt from host and slug would sign in as someone else, or
  // reach another service on the default port, so this address is tried as written.
  if (spec.exact === true) {
    return [{ label: isSsh ? "ssh" : "https", url: spec.location, viaGh: false }];
  }

  if (isSsh) {
    const https =
      spec.host !== undefined && spec.slug !== undefined
        ? `https://${spec.host}/${spec.slug}.git`
        : undefined;
    const ladder: Attempt[] = [{ label: "ssh", url: spec.location, viaGh: false }];
    if (https !== undefined) ladder.push({ label: "https", url: https, viaGh: false });
    return ladder;
  }

  const ladder: Attempt[] = [{ label: "https", url: spec.location, viaGh: false }];
  // gh reads github.com: on any other host the same owner/repo is someone else's repository.
  const slug = spec.host?.toLowerCase() === "github.com" ? spec.slug : undefined;
  if (slug !== undefined && !slug.startsWith("-") && onPath("gh", env)) {
    // A whole URL, as a bare owner/repo is read on GH_HOST or whichever host gh signed in to.
    ladder.push({ label: "gh", url: `https://github.com/${slug}`, viaGh: true });
  }
  if (ssh !== undefined) ladder.push({ label: "ssh", url: ssh, viaGh: false });
  return ladder;
}

/**
 * Git's own wording names neither the source nor the fix. Enriching here rather
 * than in clone makes resolving a private repository fail the way cloning does.
 */
export function describeFailure(
  error: unknown,
  spec: SourceSpec,
  ladder: readonly Attempt[],
): Error {
  if (!(error instanceof GitError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const tried = ladder.map((a) => a.label).join(", ");
  const host = spec.host ?? "the host";

  switch (error.failure) {
    case "unauthorized":
      if (error.sso) {
        return new GitError(
          error.failure,
          `${host} blocked access to ${spec.location}: the organization requires SAML single sign-on.`,
          error.stderr,
          "Authorize your credentials for that organization, then run the command again.",
        );
      }
      return new GitError(
        error.failure,
        `Cannot read ${spec.location} (tried ${tried}).`,
        error.stderr,
        `Check your access with \`gh auth status -h ${host}\` or \`ssh -T git@${host}\`.`,
      );
    case "not_found":
      return new GitError(
        error.failure,
        `${spec.location} is not a repository, or you cannot see it.`,
        error.stderr,
      );
    default:
      return error;
  }
}
