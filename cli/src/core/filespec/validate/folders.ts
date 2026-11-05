import { join, posix } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { hashRegular } from "#adapter/files.ts";
import { readJson } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { ENVELOPE } from "#adapter/filespec/names.ts";
import { isRemote, locatorOf } from "#adapter/filespec/resolve.ts";
import { contentDigest, type Envelope } from "#adapter/index.ts";
import { collidingPaths, isSafePath } from "#adapter/paths.ts";
import { compareVersion, parseVersion } from "#adapter/semver.ts";
import { list, quoted } from "#adapter/text.ts";
import { listed, type versionFolders } from "#core/filespec/indexer.ts";
import {
  fileProblems,
  type KindManifest,
  type kindsOf,
  specOf,
} from "#core/filespec/kind-manifests.ts";
import { check } from "#core/filespec/schema.ts";
import { authored, refusal } from "#core/fs/tree.ts";
import { type Problem, text, unparsed } from "./read.ts";

/** What `<kind> init` could not fill in, and an author has not yet. */
const PLACEHOLDER = "TODO";

/**
 * What one version's own files get wrong: the files its kind needs, its fields,
 * placeholders, and the name it sits under. `publish` asks before sending.
 */
export function versionProblems(
  manifest: KindManifest,
  at: { kind: string; name: string },
  present: ReadonlySet<string>,
  contents: ReadonlyMap<string, string>,
): string[] {
  const problems = fileProblems(manifest, present);
  const spec = specOf(manifest, contents, at.name);
  if (spec === undefined) return [...problems, "has no front matter to read its fields from"];
  problems.push(...check(manifest, spec));
  for (const field of placeholders(spec)) problems.push(`\`${field}\` is still ${PLACEHOLDER}`);
  if (typeof spec.name === "string" && spec.name !== at.name) {
    problems.push(`is named ${quoted(spec.name)} in its front matter but sits in ${at.name}/`);
  }
  return problems;
}

function placeholders(value: unknown, at = ""): string[] {
  if (value === PLACEHOLDER) return [at];
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    placeholders(item, at === "" ? key : `${at}.${key}`),
  );
}

/** The newest version folder of each artifact, by SemVer precedence. */
export function newestFolders(folders: readonly Folder[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const folder of folders) {
    const key = artifactOf(folder);
    const held = found.get(key);
    const [next, kept] = [parseVersion(folder.version), parseVersion(held ?? "")];
    if (kept === undefined || (next !== undefined && compareVersion(next, kept) > 0)) {
      found.set(key, folder.version);
    }
  }
  return found;
}

function artifactOf(folder: Folder): string {
  return `${folder.namespace}/${folder.kind}/${folder.name}`;
}

/** One version folder's problems, and whether the index no longer lists it. */
export async function folderProblems(
  root: string,
  folder: Folder,
  context: FolderContext,
): Promise<{ problems: Problem[]; stale: boolean }> {
  const { kinds, held, released, listings, blobUrl } = context;
  const problems: Problem[] = [];
  const manifest: KindManifest | undefined = kinds[folder.kind];
  const where = folder.at;
  if (manifest === undefined) {
    problems.push({
      path: where,
      message: `${quoted(folder.kind)} is not a kind this registry holds, which are ${list(Object.keys(kinds))}`,
    });
    return { problems, stale: false };
  }

  const { files, irregular } = await authored(join(root, ...where.split(posix.sep)));
  for (const entry of irregular) {
    problems.push({ path: `${where}/${entry.path}`, message: refusal(entry) });
  }
  const records = files.filter((record) => record.path !== ENVELOPE);
  const present = new Set(records.map((record) => record.path));
  const contents = new Map<string, string>();
  for (const path of present) {
    if (/\.(md|json)$/.test(path)) contents.set(path, (await text(root, `${where}/${path}`)) ?? "");
  }
  for (const message of versionProblems(manifest, folder, present, contents)) {
    problems.push({ path: where, message });
  }
  for (const to of await dependsOn(root, where)) {
    if (!held.has(to)) {
      problems.push({
        path: where,
        message: `depends on ${to}, which this registry does not hold`,
      });
    }
  }

  problems.push(...(await unwritable(root, where)));

  const releasedHere = released.get(where);
  if (releasedHere !== undefined) {
    for (const path of releasedHere) {
      problems.push({
        path,
        message: `changed since ${folder.version} was released`,
        fix: moveEdit(folder, context),
      });
    }
  }

  const pinned = await listed(root, folder, listings);
  if (!pinned.has(folder.version)) return { problems, stale: true };
  if (releasedHere !== undefined) return { problems, stale: false };
  // Released: the envelope must still describe exactly the bytes it was released with.
  const drift = await drifted(root, where, blobUrl, present, pinned.get(folder.version));
  if (drift?.blobOf !== undefined) {
    problems.push({
      path: drift.path,
      message: `${drift.message}, but ${folder.name} ${folder.version} keeps ${drift.blobOf} there`,
      fix: "restore the blob, or point blob_url in registry.json at where it is",
    });
  } else if (drift !== undefined) {
    problems.push({
      path: drift.path,
      message: `${drift.message} since ${folder.version} was released`,
      fix: moveEdit(folder, context),
    });
  }
  return { problems, stale: false };
}

type Folder = Awaited<ReturnType<typeof versionFolders>>[number];

interface FolderContext {
  kinds: Awaited<ReturnType<typeof kindsOf>>;
  held: ReadonlySet<string>;
  released: ReadonlyMap<string, string[]>;
  listings: Map<string, Map<string, unknown>>;
  blobUrl: string;
  /** Where a release's own files come back from: the base, or the last commit. */
  restoreFrom: string;
  /** Each artifact's newest version folder, the one a bump copies. */
  newest: ReadonlyMap<string, string>;
}

/** The refs a version's envelope says it depends on, as written there. */
async function dependsOn(root: string, at: string): Promise<string[]> {
  const raw = await readJson(rootReader(root), `${at}/${ENVELOPE}`).catch(() => undefined);
  const edges = isRecord(raw) ? raw.relationships : undefined;
  if (!Array.isArray(edges)) return [];
  return edges.flatMap((edge) => {
    const { rel_type: type, to } = (edge ?? {}) as { rel_type?: unknown; to?: unknown };
    return type === "depends_on" && typeof to === "string" ? [to] : [];
  });
}

/** Paths a version's envelope describes that no client writes: the grammar every reader enforces. */
async function unwritable(root: string, at: string): Promise<Problem[]> {
  const raw = await readJson(rootReader(root), `${at}/${ENVELOPE}`).catch(() => undefined);
  const files = isRecord(raw) && Array.isArray(raw.files) ? raw.files : [];
  const paths = files.flatMap((file) =>
    isRecord(file) && typeof file.path === "string" ? [file.path] : [],
  );
  const where = `${at}/${ENVELOPE}`;
  const problems: Problem[] = paths
    .filter((path) => !isSafePath(path))
    .map((path) => ({
      path: where,
      message: `describes ${quoted(path)}, which is not a path inside the artifact`,
    }));
  const clash = collidingPaths(paths);
  if (clash !== undefined) {
    problems.push({
      path: where,
      message: `describes ${quoted(clash[0])} and ${quoted(clash[1])}, which are one file on most disks`,
    });
  }
  return problems;
}

/**
 * A release is never edited: the edit goes into the next version and the release comes back
 * as it was. A bump copies the newest folder, so only that one carries the edit across.
 */
function moveEdit(folder: Folder, context: Pick<FolderContext, "restoreFrom" | "newest">): string {
  const bump = `aireg ${folder.kind} bump ${folder.name} --namespace ${folder.namespace}`;
  const restore = `git checkout ${context.restoreFrom} -- ${folder.at}`;
  return context.newest.get(artifactOf(folder)) === folder.version
    ? `${bump} && ${restore} && aireg registry index`
    : `${restore}, then make the change in a new version: ${bump}`;
}

/**
 * The first way a released version's files no longer match its envelope, if any. A file
 * the blob store holds is named by its blob, since the version folder never held it.
 */
async function drifted(
  root: string,
  at: string,
  blobUrl: string,
  present: ReadonlySet<string>,
  pinned: unknown,
): Promise<{ path: string; message: string; blobOf?: string } | undefined> {
  let envelope: Envelope | undefined;
  try {
    envelope = (await readJson(rootReader(root), `${at}/${ENVELOPE}`)) as Envelope | undefined;
  } catch (error) {
    if (unparsed(error)) return { path: `${at}/${ENVELOPE}`, message: "is not valid JSON" };
  }
  if (envelope === undefined) return { path: `${at}/${ENVELOPE}`, message: "is missing" };
  if (
    envelope.metadata?.digest !== contentDigest(envelope) ||
    envelope.metadata.digest !== pinned
  ) {
    return { path: `${at}/${ENVELOPE}`, message: "was edited" };
  }
  const described = new Set<string>();
  for (const file of envelope.files ?? []) {
    described.add(file.path);
    const locator = locatorOf(file, at, blobUrl);
    // A blob on another host is verified by whoever fetches it.
    if (isRemote(locator)) continue;
    const blob = locator.startsWith(`${at}/`) ? {} : { blobOf: file.path };
    // Streamed, so a large asset is hashed without holding it, and a read
    // that fails for another reason is never reported as a missing file.
    const read = await hashed(root, locator);
    if ("problem" in read) return { path: locator, message: read.problem, ...blob };
    if (read.digest !== file.digest || read.size !== file.size) {
      return { path: locator, message: "changed", ...blob };
    }
  }
  const added = [...present].find((path) => !described.has(path));
  return added === undefined ? undefined : { path: `${at}/${added}`, message: "was added" };
}

async function hashed(
  root: string,
  path: string,
): Promise<{ digest: string; size: number } | { problem: string }> {
  try {
    const read = await hashRegular(root, path);
    if (read.kind === "missing") return { problem: "is missing" };
    if (read.kind === "refused") return { problem: read.reason };
    return read;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { problem: "is missing" };
    return { problem: code === undefined ? "could not be read" : `could not be read (${code})` };
  }
}
