import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  compareVersion,
  formatVersion,
  parseVersion,
  quoted,
  sanitizeName,
  sha256,
  type Version,
} from "#adapter/index.ts";
import { transportEnv } from "./env.ts";
import { GitError, type GitLimits, git } from "./exec.ts";
import { lsRemote, peel } from "./resolve.ts";
import { overLadder } from "./transport.ts";
import type { SourceSpec } from "./url.ts";

// A git source that is not a registry has no versions.json: its versions are its tags, and a
// commit no tag names gets a pseudo-version, so every commit has exactly one version.

/** One tag, and the commit it names once peeled. */
export interface Tag {
  name: string;
  commit: string;
}

/** A tag's version: `v1.2.0` or `1.2.0` for the whole repository, `<name>/v1.2.0` for one artifact. */
interface Tagged {
  tag: Tag;
  version: Version;
  /** The artifact it versions alone, when it is one artifact's tag. */
  artifact: string | undefined;
}

const SHA12 = /^[0-9a-f]{12}$/;

function versionOf(text: string): Version | undefined {
  return parseVersion(text.startsWith("v") ? text.slice(1) : text);
}

function taggedOf(tag: Tag): Tagged | undefined {
  // `<name>/v1.2.0` or `<name>--v1.2.0` names one artifact's release.
  const split = /^(.+?)(?:\/|--)(v?\d[^/]*)$/.exec(tag.name);
  if (split !== null) {
    const version = versionOf(split[2] as string);
    const artifact = split[1] as string;
    if (version !== undefined && !artifact.includes("/")) return { tag, version, artifact };
  }
  const version = tag.name.includes("/") ? undefined : versionOf(tag.name);
  return version === undefined ? undefined : { tag, version, artifact: undefined };
}

/** Every tag of the repository, with the commit each one names. */
async function listTags(spec: SourceSpec, limits: GitLimits): Promise<Tag[]> {
  const refs = await lsRemote(spec, ["refs/tags/*"], limits);
  const names = new Set(
    refs
      .map((ref) => ref.name)
      .filter((name) => name.startsWith("refs/tags/") && !name.endsWith("^{}")),
  );
  return [...names]
    .map((name) => ({ name: name.slice("refs/tags/".length), commit: peel(refs, name)?.commit }))
    .filter((tag): tag is Tag => tag.commit !== undefined)
    .map((tag) => ({ ...tag, commit: tag.commit.toLowerCase() }));
}

/** The newest of `versions`, by SemVer precedence. */
function newest(found: readonly Tagged[]): Tagged | undefined {
  return [...found].sort((a, b) => compareVersion(b.version, a.version))[0];
}

/** The newest release the whole repository is tagged with, which a source without a ref follows. */
export function releaseTag(tags: readonly Tag[]): Tagged | undefined {
  const releases = tags
    .map(taggedOf)
    .filter((item): item is Tagged => item !== undefined && item.artifact === undefined)
    .filter((item) => item.version.prerelease.length === 0);
  return newest(releases);
}

/** An artifact's own tags win over the repository's, for the version it is served at. */
function forArtifact(tagged: readonly Tagged[], name: string): Tagged[] {
  const own = tagged.filter((item) => item.artifact === name);
  return own.length > 0 ? own : tagged.filter((item) => item.artifact === undefined);
}

/** `yyyymmddhhmmss` in UTC, as a pseudo-version writes a commit's time. */
function stamp(time: Date): string {
  return time.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * A commit no tag names. Without the leading `v`, so it is SemVer, and a prerelease, so it sorts
 * after the tag it descends from and before the next release.
 */
export function pseudoVersion(base: Version | undefined, time: Date, commit: string): string {
  const suffix = `${stamp(time)}-${commit.slice(0, 12)}`;
  if (base === undefined) return `0.0.0-${suffix}`;
  if (base.prerelease.length > 0) return `${formatVersion(base)}.0.${suffix}`;
  return `${base.major}.${base.minor}.${base.patch + 1}-0.${suffix}`;
}

/** The time and commit a pseudo-version names, when it is one. */
export function readPseudo(version: string): { stamp: string; sha: string } | undefined {
  const match = /(?:^0\.0\.0-|-0\.|\.0\.)(\d{14})-([0-9a-f]{12})$/.exec(version);
  if (match === null || parseVersion(version) === undefined) return undefined;
  return { stamp: match[1] as string, sha: match[2] as string };
}

/** What `GitVersions` reads with: the source, its limits, and where the host lets it keep a clone. */
export interface VersionContext {
  spec: SourceSpec;
  limits: GitLimits;
  cacheDir: () => string;
  exclusive<T>(key: string, run: () => Promise<T>): Promise<T>;
}

/** Tags, and the repository's history when a version needs it, read once per connection. */
export class GitVersions {
  readonly #context: VersionContext;
  #tags: Promise<Tag[]> | undefined;
  #history: Promise<string> | undefined;

  constructor(context: VersionContext) {
    this.#context = context;
  }

  tags(): Promise<Tag[]> {
    this.#tags ??= listTags(this.#context.spec, this.#context.limits);
    return this.#tags;
  }

  /** The commit an exact version names: an artifact's own tag first, then the repository's. */
  async commitOf(version: string, name: string): Promise<string> {
    const pseudo = readPseudo(version);
    if (pseudo !== undefined) return this.#pseudoCommit(version, pseudo);
    const wanted = parseVersion(version);
    const tagged = (await this.tags()).map(taggedOf).filter((item) => item !== undefined);
    const same = (item: Tagged) =>
      wanted !== undefined && compareVersion(item.version, wanted) === 0;
    const found =
      forArtifact(tagged, name).find(same) ??
      tagged.find((item) => item.artifact === undefined && same(item));
    if (found === undefined) {
      const offered = releasesFor(tagged, name);
      throw new GitError(
        "not_found",
        `${this.#context.spec.location} has no tag for ${name} ${version}.`,
        "",
        offered.length === 0
          ? "Leave off the version to install what the repository holds now."
          : `Use ${offered.slice(0, 5).join(", ")}, or leave off the version for the newest.`,
      );
    }
    return found.tag.commit;
  }

  /** The version each artifact is served at from `commit`, by name. */
  async versionsAt(
    commit: string,
    names: readonly string[],
    checkout: string,
  ): Promise<Map<string, string>> {
    const tagged = (await this.tags()).map(taggedOf).filter((item) => item !== undefined);
    const versions = new Map<string, string>();
    const untagged: string[] = [];
    for (const name of names) {
      const exact = newest(forArtifact(tagged, name).filter((item) => item.tag.commit === commit));
      if (exact === undefined) untagged.push(name);
      else versions.set(name, formatVersion(exact.version));
    }
    if (untagged.length === 0) return versions;
    const time =
      (await commitTime(checkout, this.#context.limits)) ??
      (await commitTime(await this.history(), this.#context.limits, commit));
    if (time === undefined) {
      throw new GitError("invalid", `${this.#context.spec.location} gave no time for ${commit}.`);
    }
    // Only a repository with tags has an ancestor to name; one without needs no history.
    const merged = tagged.length === 0 ? [] : await this.#mergedInto(commit);
    const ancestors = tagged.filter((item) => merged.includes(item.tag.name));
    for (const name of untagged) {
      const base = newest(forArtifact(ancestors, name))?.version;
      versions.set(name, pseudoVersion(base, time, commit));
    }
    return versions;
  }

  async #pseudoCommit(version: string, pseudo: { stamp: string; sha: string }): Promise<string> {
    const history = await this.history();
    const found = SHA12.test(pseudo.sha)
      ? (
          await git(["rev-parse", "--verify", "--quiet", `${pseudo.sha}^{commit}`], {
            ...this.#context.limits,
            cwd: history,
          }).catch(() => "")
        ).trim()
      : "";
    const time = found === "" ? undefined : await commitTime(history, this.#context.limits, found);
    // The time is checked too, so a version cannot name a commit it was not made from.
    if (time === undefined || stamp(time) !== pseudo.stamp) {
      throw new GitError(
        "not_found",
        `${this.#context.spec.location} has no commit for the version ${quoted(version)}.`,
        "",
        "Leave off the version to install what the repository holds now.",
      );
    }
    return found.toLowerCase();
  }

  async #mergedInto(commit: string): Promise<string[]> {
    const history = await this.history();
    const out = await git(["tag", "--merged", commit], { ...this.#context.limits, cwd: history });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  /** A bare clone holding every commit and tag but no files, kept between runs and fetched into. */
  history(): Promise<string> {
    this.#history ??= this.#fetchHistory();
    return this.#history;
  }

  async #fetchHistory(): Promise<string> {
    const { spec, limits } = this.#context;
    const dir = join(this.#context.cacheDir(), "history", historyKey(spec));
    return this.#context.exclusive(dir, () =>
      overLadder(spec, limits, async (attempt) => {
        const env = transportEnv(attempt.url);
        if (existsSync(join(dir, "HEAD"))) {
          await git(["remote", "set-url", "origin", "--", attempt.url], { ...limits, cwd: dir });
          await git(
            [
              ...attempt.config,
              "fetch",
              "--quiet",
              "--force",
              "--prune",
              "--tags",
              "origin",
              "+refs/heads/*:refs/heads/*",
            ],
            { ...limits, cwd: dir, env },
          );
        } else {
          await rm(dir, { recursive: true, force: true });
          await mkdir(dirname(dir), { recursive: true });
          // Commits only: the history answers which tags a commit descends from, never what it holds.
          await git(
            [
              ...attempt.config,
              "clone",
              "--bare",
              "--quiet",
              "--filter=tree:0",
              "--end-of-options",
              attempt.url,
              dir,
            ],
            { ...limits, env },
          );
        }
        return dir;
      }),
    );
  }
}

function releasesFor(tagged: readonly Tagged[], name: string): string[] {
  return forArtifact(tagged, name)
    .filter((item) => item.version.prerelease.length === 0)
    .sort((a, b) => compareVersion(b.version, a.version))
    .map((item) => formatVersion(item.version));
}

function historyKey(spec: SourceSpec): string {
  const named = spec.host !== undefined && spec.slug !== undefined;
  const label = named ? `${spec.host}-${spec.slug}` : spec.alias;
  return `${sanitizeName(label)}-${sha256(spec.location).slice(7, 19)}`;
}

/** When a commit was made, from a repository that holds it. */
async function commitTime(
  dir: string,
  limits: GitLimits,
  commit = "HEAD",
): Promise<Date | undefined> {
  const out = await git(["log", "-1", "--format=%ct", commit], { ...limits, cwd: dir }).catch(
    () => "",
  );
  const seconds = Number.parseInt(out.trim(), 10);
  return Number.isSafeInteger(seconds) ? new Date(seconds * 1000) : undefined;
}
