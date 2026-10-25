import { existsSync, lstatSync, realpathSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import type { ArtifactKind } from "#adapter/index.ts";
import { isWithin } from "#adapter/paths.ts";
import { quoted, sanitizeName } from "#adapter/text.ts";
import { matchInstalled, rowsNamed } from "#cli/names.ts";
import { descriptionText, frontmatter } from "#core/catalog/frontmatter.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isAbsent } from "#core/fs/path.ts";
import { gitIn } from "#core/git.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "#core/kinds.ts";
import type { LockArtifact } from "#core/lock.ts";
import type { Export, ExportFile } from "#core/manifest.ts";
import { refuseRedirectedCopy } from "#core/store/managed-paths.ts";
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
  /** The manifest's `exports:` entries for this path, merged, whose version, dependencies and targets apply. */
  exported?: Exported | undefined;
}

/** What `exports:` says of one artifact: its entries merged into one, and the files it publishes. */
export interface Exported extends Export {
  /** Selected folder files, with the entry first; absent for a native agent file. */
  files?: readonly ExportFile[] | undefined;
}

const SHAPE_HINT =
  "Name a skill folder that holds SKILL.md, an agent's folder that holds AGENT.md, or an agent's .md file.";

function copyPath(key: string, entry: LockArtifact, loaded: Loaded): string {
  return artifactPath(
    loaded.roots,
    entry.registry,
    entry.namespace,
    entry.kind,
    copyLeaf(key, entry.name),
    // A watched row has no address yet; its recorded path still carries the extension.
    entry.address ?? entry.path,
  );
}

function installed(key: string, entry: LockArtifact, loaded: Loaded): Work {
  const path = copyPath(key, entry, loaded);
  refuseRedirectedCopy(key, path, loaded.roots);
  return {
    name: entry.name,
    kind: entry.kind,
    path,
    description: undefined,
    home: { registry: entry.registry, namespace: entry.namespace },
    row: key,
    base: entry.version,
  };
}

async function textAt(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isAbsent(error) || (error as NodeJS.ErrnoException).code === "EISDIR") return undefined;
    throw error;
  }
}

async function folderEntry(
  root: string,
): Promise<{ kind: ArtifactKind; text: string } | undefined> {
  const [skill, agent] = await Promise.all([
    textAt(join(root, SKILL_ENTRY)),
    textAt(join(root, AGENT_ENTRY)),
  ]);
  if (skill !== undefined) return { kind: "skill", text: skill };
  return agent === undefined ? undefined : { kind: "agent", text: agent };
}

/** Read each entry once to identify a skill, folder agent or native agent file. */
export async function fromPath(path: string): Promise<Work> {
  const entry = basename(path) === SKILL_ENTRY;
  const root = entry ? dirname(path) : path;
  const inside = await folderEntry(root);
  const text =
    inside === undefined && !entry && extname(path) === ".md" ? await textAt(path) : undefined;
  const kind = inside?.kind ?? (text === undefined ? undefined : "agent");
  if (kind === undefined) {
    throw new AiregError(`${path} is not an artifact.`, {
      code: ErrorCode.Invalid,
      hint: SHAPE_HINT,
    });
  }
  const folder = inside !== undefined;
  const meta = frontmatter(inside?.text ?? (text as string));
  const fallback = folder ? basename(root) : basename(path, ".md");
  return {
    name: sanitizeName(meta.name ?? fallback),
    kind,
    path: folder ? root : path,
    description: meta.description === undefined ? undefined : descriptionText(meta.description),
    home: undefined,
    row: undefined,
    base: undefined,
  };
}

export async function expand(pattern: string, cwd: string): Promise<string[]> {
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
    for (const path of paths) {
      const target = linkTarget(path);
      if (target === undefined) {
        works.push(await fromPath(path));
        continue;
      }
      // A harness folder links each installed copy; publishing the link publishes that row.
      const row = Object.entries(rows).find(([name, entry]) => {
        const copy = copyPath(name, entry, loaded);
        return existsSync(copy) && realpathSync(copy) === target;
      });
      if (row === undefined) throw linkedRoot(path, target);
      works.push(installed(row[0], row[1], loaded));
    }
  }
  return works;
}

/** Where `path` leads when it is itself a link, else undefined. */
function linkTarget(path: string): string | undefined {
  if (!lstatSync(path).isSymbolicLink()) return undefined;
  return existsSync(path) ? realpathSync(path) : undefined;
}

function linkedRoot(path: string, target: string): AiregError {
  return new AiregError(`${basename(path)} is a symlink; an artifact holds regular files only.`, {
    code: ErrorCode.Invalid,
    hint: `Publish the folder it points to: \`aireg publish ${quoted(target)}\`.`,
  });
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
