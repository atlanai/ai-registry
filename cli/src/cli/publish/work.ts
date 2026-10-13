import { existsSync } from "node:fs";
import { glob, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import type { ArtifactKind } from "#adapter/index.ts";
import { isWithin } from "#adapter/paths.ts";
import { quoted, sanitizeName } from "#adapter/text.ts";
import { matchInstalled, rowsNamed } from "#cli/names.ts";
import { descriptionText, frontmatter } from "#core/catalog/frontmatter.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { gitIn } from "#core/git.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import type { LockArtifact } from "#core/lock.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Loaded } from "#engine/pipeline.ts";
import { closeScan, scan } from "#engine/scan.ts";

/** One artifact to publish: what it is, and where its bytes are. */
export interface Work {
  name: string;
  kind: ArtifactKind;
  path: string;
  description: string | undefined;
  /** Where it was installed from, which is where it goes when `--to` says nothing. */
  home: { registry: string; namespace: string | undefined } | undefined;
  /** The installed row, so the lock can follow what was published. */
  row: string | undefined;
  /** The version an installed copy was edited from, so a newer one is not written over. */
  base: string | undefined;
  /** The harness a watched folder's file was written for, which its stored copy does not say. */
  harness?: string | undefined;
}

const SHAPE_HINT = "Name a skill folder that holds SKILL.md, or an agent's .md file.";

function installed(key: string, entry: LockArtifact, loaded: Loaded): Work {
  return {
    name: entry.name,
    kind: entry.kind,
    path: artifactPath(
      loaded.roots,
      entry.registry,
      entry.namespace,
      entry.kind,
      copyLeaf(key, entry.name),
      // A watched row has no address yet; its recorded path still carries the extension.
      entry.address ?? entry.path,
    ),
    description: undefined,
    home: { registry: entry.registry, namespace: entry.namespace },
    row: key,
    base: entry.version,
    harness: entry.origin?.harness,
  };
}

/** A skill is a directory with SKILL.md, reached by either; any other .md is an agent. */
async function fromPath(path: string): Promise<Work> {
  const isDir = (await stat(path)).isDirectory();
  const root = !isDir && basename(path) === SKILL_ENTRY ? dirname(path) : path;
  const skill = isDir || root !== path;
  if (skill && !existsSync(join(root, SKILL_ENTRY))) {
    throw new AiregError(`${path} is not an artifact.`, {
      code: ErrorCode.Invalid,
      hint: SHAPE_HINT,
    });
  }
  if (!skill && extname(path) !== ".md") {
    throw new AiregError(`${path} is not an artifact.`, {
      code: ErrorCode.Invalid,
      hint: SHAPE_HINT,
    });
  }
  const meta = frontmatter(await readFile(skill ? join(root, SKILL_ENTRY) : path, "utf8"));
  const fallback = skill ? basename(root) : basename(path, ".md");
  return {
    name: sanitizeName(meta.name ?? fallback),
    kind: skill ? "skill" : "agent",
    path: root,
    description: meta.description === undefined ? undefined : descriptionText(meta.description),
    home: undefined,
    row: undefined,
    base: undefined,
  };
}

async function expand(pattern: string, cwd: string): Promise<string[]> {
  const found: string[] = [];
  for await (const match of glob(pattern, { cwd })) found.push(resolve(cwd, match));
  if (found.length === 0 && existsSync(resolve(cwd, pattern))) found.push(resolve(cwd, pattern));
  return found.sort();
}

/** Each argument is a path, a glob over paths, or an installed name; a folder beside you wins. */
export async function fromArgs(
  args: readonly string[],
  loaded: Loaded,
  cwd: string,
): Promise<Work[]> {
  const rows = loaded.lock.artifacts;
  const works: Work[] = [];
  for (const arg of args) {
    const key = existsSync(resolve(cwd, arg))
      ? undefined
      : matchInstalled(arg, loaded.lock).rows.length > 0
        ? rowsNamed(arg, loaded.lock)[0]
        : undefined;
    if (key !== undefined) {
      works.push(installed(key, rows[key] as LockArtifact, loaded));
      continue;
    }
    const paths = await expand(arg, cwd);
    if (paths.length === 0) {
      throw new AiregError(`Nothing matches ${quoted(arg)}.`, {
        code: ErrorCode.NotFound,
        hint: "Name a path, a glob such as 'skills/*', or an installed artifact.",
      });
    }
    for (const path of paths) works.push(await fromPath(path));
  }
  return works;
}

/** Only the work whose files differ from `rev`, so a push publishes what it changed. */
export async function changedSince(works: Work[], rev: string, cwd: string): Promise<Work[]> {
  const verify = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`];
  const verified = await gitIn(cwd, verify);
  if (verified.code !== 0) {
    throw new AiregError(`${quoted(rev)} is not a commit in this repository.`, {
      code: ErrorCode.Usage,
      hint: "Fetch enough history to include it. In CI, check out with fetch-depth: 0.",
    });
  }
  const commit = verified.stdout.trim();
  const diff = await gitIn(cwd, ["diff", "--name-only", "-z", "--relative", commit, "--"]);
  if (diff.code !== 0) {
    throw new AiregError(`Could not list what changed since ${quoted(rev)}.`, {
      hint: diff.stderr.trim().split("\n")[0],
    });
  }
  const changed = diff.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => resolve(cwd, file));
  return works.filter((work) => changed.some((file) => isWithin(work.path, file)));
}

/** What this scope changed or wrote that its registries do not hold yet. */
export async function edited(loaded: Loaded, common: CommonOptions, cwd: string): Promise<Work[]> {
  const found = await scan(loaded, common, {
    credentials: await credentialsForManifest(loaded.manifest.registries, cwd),
  });
  await closeScan(found);
  const works: Work[] = [];
  for (const item of found.items) {
    if (item.disposition !== "publish") continue;
    const entry = loaded.lock.artifacts[item.name];
    if (entry !== undefined) works.push(installed(item.name, entry, loaded));
  }
  for (const candidate of found.local) {
    works.push({
      name: candidate.name,
      kind: candidate.kind,
      path: candidate.from,
      description: candidate.description,
      home: undefined,
      row: undefined,
      base: undefined,
    });
  }
  return works;
}
