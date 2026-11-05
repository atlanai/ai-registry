import { resolve } from "node:path";
import {
  AdapterError,
  expandHome,
  isLocalPath,
  namesHost,
  problemFromFailure,
  quoted,
  registryNameFromLocation,
  SCP_LOCATION,
  stripLeading,
  stripTrailing,
  withoutCredentials,
} from "#adapter/index.ts";
import { ID } from "./errors.ts";

export interface SourceSpec {
  /** Clone URL, or an absolute directory for a local source. */
  location: string;
  kind: "git" | "path";
  /** Tag, branch or sha the user asked for. */
  ref: string | undefined;
  /** Default registry alias, derived from the repository name. */
  alias: string;
  /** `owner/repo` when the host is recognizable, for the SSH fallback. */
  slug: string | undefined;
  host: string | undefined;
  /** The folder inside the repository that holds the registry, from a pasted link. */
  path?: string | undefined;
  /**
   * The address names an account or a port of its own, which a fallback rebuilt from
   * the host and slug would drop, so it is tried only as written.
   */
  exact?: boolean | undefined;
}

/**
 * A link copied from a code host's page: `…/owner/repo/tree/<ref>/<folder>` is the
 * repository at that ref with its registry in that folder.
 */
export function pastedRepository(
  input: string,
): { location: string; ref: string | undefined; path: string | undefined } | undefined {
  const match =
    /^(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:-\/)?(?:tree|blob)\/([^/\s]+)(?:\/(\S*?))?)?\/?$/i.exec(
      input,
    );
  if (match === null) return undefined;
  const [, host, owner, repo, ref, folder] = match as unknown as [
    string,
    string,
    string,
    string,
    string?,
    string?,
  ];
  const path = folder === undefined || folder === "" ? undefined : stripTrailing(folder, "/");
  const plain = /^www\./i.test(input.replace(/^https?:\/\//i, ""));
  if (ref === undefined && !plain && !/^https?:/i.test(input)) return undefined;
  return { location: `${host.toLowerCase()}/${owner}/${repo}`, ref, path };
}

/**
 * A GitHub repository is always `owner/repo`, so any path after it is an
 * address inside that registry rather than part of the repository's name.
 */
export function splitRepository(input: string): { location: string; rest: string } | undefined {
  const match = /^(?:https:\/\/)?(github\.com\/[^/\s]+\/[^/\s@]+?)(?:\.git)?\/(\S+)$/i.exec(input);
  if (match === null) return undefined;
  const [, location, rest] = match as unknown as [string, string, string];
  if (/^(tree|blob)\//.test(rest)) return undefined;
  return { location, rest };
}

/** An address typed wrong, which the host reports as a usage error. */
export class SourceParseError extends AdapterError {
  constructor(input: string, reason: string, hint?: string) {
    const message = `${quoted(withoutCredentials(input))} is not a registry address: ${reason}.`;
    super(ID, "invalid", message, {
      hint,
      problem: { ...problemFromFailure("invalid", message), code: "USAGE" },
    });
  }
}

export function parseSource(input: string, cwd = process.cwd()): SourceSpec {
  const trimmed = input.trim();
  if (trimmed === "") throw new SourceParseError(input, "it is empty");
  if (/^ext::/i.test(trimmed)) {
    throw new SourceParseError(input, "the ext:: transport runs any command it is given");
  }
  // A pasted link's anchor points into a page; anywhere else `#` would read as a ref.
  const link = /^(https?:\/\/|www\.)/i.test(trimmed);
  if (!link && trimmed.includes("#")) {
    throw new SourceParseError(
      input,
      "it names a ref with #",
      "Name a branch or tag with `@ref`, not `#ref`.",
    );
  }
  const unanchored = trimmed.replace(/#.*$/, "");
  const pasted = pastedRepository(unanchored);
  if (pasted !== undefined) {
    const inner = parseSource(pasted.location, cwd);
    return { ...inner, ref: pasted.ref ?? inner.ref, path: pasted.path };
  }

  const { address, ref } = splitRef(unanchored);

  if (isLocalPath(address)) {
    const location = resolve(cwd, expandHome(address));
    if (ref !== undefined) throw new SourceParseError(input, "a local path has no ref");
    return {
      location,
      kind: "path",
      ref: undefined,
      alias: registryNameFromLocation(location, "registry"),
      slug: undefined,
      host: undefined,
    };
  }

  const scp = SCP_LOCATION.exec(address);
  if (scp !== null) {
    const [, user, host, path] = scp;
    return {
      location: `${user ?? "git"}@${host}:${path}`,
      kind: "git",
      ref,
      alias: registryNameFromLocation(path ?? address, "registry"),
      slug: (path ?? "").replace(/\.git$/, ""),
      host,
      exact: user !== undefined && user !== "git",
    };
  }

  if (!namesHost(address)) {
    throw new SourceParseError(
      input,
      "it names no host",
      "Name the host too, such as github.com/owner/repo.",
    );
  }

  let url: URL;
  try {
    url = new URL(address.includes("://") ? address : `https://${address}`);
  } catch {
    throw new SourceParseError(input, "it is not a repository URL or a local path");
  }

  const path = stripLeading(stripTrailing(url.pathname, "/"), "/").replace(/\.git$/, "");
  if (path === "") throw new SourceParseError(input, "the URL names no repository");

  return {
    location: cloneUrl(url, path),
    kind: "git",
    ref,
    alias: registryNameFromLocation(path, "registry"),
    slug: path.split("/").length === 2 ? path : undefined,
    host: url.hostname,
    exact:
      (url.port !== "" && !(url.protocol === "ssh:" && url.port === "22")) || namesSshUser(url),
  };
}

/**
 * A `@ref` suffix only counts after the final `/`, so `git@github.com:o/r`
 * keeps its user and `o/r@v2` is split.
 */
function splitRef(input: string): { address: string; ref: string | undefined } {
  const at = input.lastIndexOf("@");
  if (at <= 0 || at < input.lastIndexOf("/")) return { address: input, ref: undefined };
  const ref = input.slice(at + 1);
  return ref === "" ? { address: input, ref: undefined } : { address: input.slice(0, at), ref };
}

/** file:// is a git transport, not a directory read: `./dir` is the latter. */
function cloneUrl(url: URL, path: string): string {
  if (url.protocol === "file:") return url.href;
  // Built by hand: `url.origin` is "null" for a scheme the URL standard does not know, like ssh:.
  const user = url.protocol === "ssh:" && url.username !== "" ? `${url.username}@` : "";
  return `${url.protocol}//${user}${url.host}/${path}.git`;
}

/** `cloneUrl` keeps a user only for ssh:, so only there does a user make the address exact. */
function namesSshUser(url: URL): boolean {
  return url.protocol === "ssh:" && url.username !== "" && url.username !== "git";
}

/** The SSH form of an HTTPS clone URL, for the auth fallback. */
export function sshUrl(spec: SourceSpec): string | undefined {
  if (spec.host === undefined || spec.slug === undefined) return undefined;
  return `git@${spec.host}:${spec.slug}.git`;
}
