import { join, posix } from "node:path";
import { hashRegular } from "#adapter/files.ts";
import {
  DEFAULT_BLOB_URL,
  readJson,
  readRegistry,
  SpecError,
} from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import {
  ENVELOPE,
  INDEX_DOCUMENT,
  isArtifactName,
  isDeviceName,
  isKindSegment,
  isNamespace,
  isVersion,
  REGISTRY_DOCUMENT,
  VERSIONS_DOCUMENT,
  versionsPath,
} from "#adapter/filespec/names.ts";
import { isRemote, locatorOf } from "#adapter/filespec/resolve.ts";
import { newest } from "#adapter/filespec/write.ts";
import { contentDigest, type Envelope } from "#adapter/index.ts";
import { collidingPaths, isSafePath } from "#adapter/paths.ts";
import { compareVersion, parseVersion } from "#adapter/semver.ts";
import { catalogDigest } from "#adapter/spec/canonical.ts";
import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord } from "#core/fields.ts";
import { authored, exists, refusal, subdirectories } from "#core/fs/tree.ts";
import { gitIn } from "#core/git.ts";
import { sentence } from "#core/output.ts";
import { listed, versionFolders } from "./indexer.ts";
import {
  check,
  type KindManifest,
  kindsOf,
  manifestProblems,
  missingFiles,
  specOf,
} from "./kinds.ts";

interface Problem {
  /** Root-relative, POSIX: the file or folder to look at. */
  path: string;
  message: string;
  /** The command, or the edit, that fixes it. */
  fix?: string | undefined;
}

export interface Validated {
  name: string;
  namespaces: number;
  artifacts: number;
  versions: number;
  problems: Problem[];
}

async function text(root: string, path: string): Promise<string | undefined> {
  try {
    const bytes = await rootReader(root)(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** A document that is there but does not parse, as opposed to one refused or missing. */
function unparsed(error: unknown): boolean {
  return error instanceof SpecError && error.cause instanceof SyntaxError;
}

async function jsonAt(root: string, path: string, problems: Problem[]): Promise<unknown> {
  try {
    return await readJson(rootReader(root), path);
  } catch (error) {
    if (unparsed(error)) problems.push({ path, message: "is not valid JSON" });
    return undefined;
  }
}

/** Every folder under `artifacts/` the path grammar refuses, named at the level it breaks. */
async function layout(root: string, problems: Problem[]): Promise<void> {
  const levels: [(value: string) => boolean, string][] = [
    [isNamespace, "a namespace"],
    [isKindSegment, "a kind"],
    [isArtifactName, "a name: lowercase letters, digits and hyphens"],
    [isVersion, "a version"],
  ];
  async function visit(dir: string, rel: string, depth: number): Promise<void> {
    const level = levels[depth];
    if (level === undefined) return;
    for (const child of await subdirectories(dir)) {
      const at = `${rel}/${child}`;
      if (isDeviceName(child)) {
        problems.push({ path: at, message: `${quoted(child)} is a device name on Windows` });
        continue;
      }
      if (!level[0](child)) {
        problems.push({ path: at, message: `${quoted(child)} is not ${level[1]}` });
        continue;
      }
      await visit(join(dir, child), at, depth + 1);
    }
  }
  await visit(join(root, "artifacts"), "artifacts", 0);
}

/** A CI checkout holds one commit; the tip of the target branch is all a comparison needs. */
async function fetchIfMissing(root: string, base: string): Promise<void> {
  const found = await gitIn(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", base]);
  if (found.code === 0) return;
  const branch = /^origin\/(.+)$/.exec(base)?.[1];
  if (branch === undefined) return;
  await gitIn(root, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

/** What changed under `artifacts/` since the base, root-relative, and the base's own copies. */
interface BaseDiff {
  /** The ref as the author gave it, for the fixes printed. */
  ref: string;
  paths: string[];
  /** Each artifact's released versions in the base, by its `versions.json` path. */
  released: (versionsAt: string) => Promise<Map<string, unknown>>;
}

async function baseDiff(root: string, base: string): Promise<BaseDiff> {
  // A ref git would read as an option, such as `--output=<file>`, never reaches it.
  if (base.startsWith("-")) {
    throw new AiregError(`--base takes a git ref, not ${quoted(base)}.`, { code: ErrorCode.Usage });
  }
  await fetchIfMissing(root, base);
  const resolved = await gitIn(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${base}^{commit}`,
  ]);
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || commit === "") {
    throw new AiregError(`No commit named ${quoted(base)} to compare with.`, {
      code: ErrorCode.NotFound,
      hint: "Fetch it, or pass another `--base <ref>`.",
    });
  }
  const diff = await gitIn(root, ["diff", "--name-only", commit, "--", "artifacts"]);
  if (diff.code !== 0) {
    throw new AiregError(`Could not compare with ${quoted(base)}: ${sentence(diff.stderr)}`, {
      code: ErrorCode.NotFound,
      hint: "Fetch it, or pass another `--base <ref>`.",
    });
  }
  const shown = await gitIn(root, ["rev-parse", "--show-prefix"]);
  if (shown.code !== 0) {
    throw new AiregError(sentence(shown.stderr), { code: ErrorCode.Unavailable });
  }
  const prefix = shown.stdout.trim();
  const paths = diff.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => (prefix !== "" && line.startsWith(prefix) ? line.slice(prefix.length) : line));
  const cache = new Map<string, Promise<Map<string, unknown>>>();
  const released = (versionsAt: string) => {
    let found = cache.get(versionsAt);
    if (found === undefined) {
      found = gitIn(root, ["show", `${commit}:./${versionsAt}`]).then((before) =>
        before.code === 0 ? rowsOf(parsed(before.stdout)) : new Map(),
      );
      cache.set(versionsAt, found);
    }
    return found;
  };
  return { ref: base, paths, released };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Each listed version and its digest, parsed rather than matched, so any formatting reads alike. */
function rowsOf(document: unknown): Map<string, unknown> {
  const rows = isRecord(document) && Array.isArray(document.versions) ? document.versions : [];
  return new Map(
    rows.flatMap((row) =>
      isRecord(row) && typeof row.version === "string" ? [[row.version, row.digest] as const] : [],
    ),
  );
}

/** Version folders the base revision already released, which no change may touch. */
async function releasedChanges(diff: BaseDiff): Promise<Map<string, string[]>> {
  const changed = new Map<string, string[]>();
  for (const path of diff.paths) {
    const parts = path.split("/");
    if (parts.length < 6 || parts[0] !== "artifacts") continue;
    const folder = parts.slice(0, 5).join("/");
    const [, namespace, kind, name, version] = parts as [string, string, string, string, string];
    if (!(await diff.released(versionsPath(namespace, kind, name))).has(version)) continue;
    changed.set(folder, [...(changed.get(folder) ?? []), path]);
  }
  return changed;
}

/**
 * Rule 1 and rule 7: a `versions.json` may reorder its rows and change their status,
 * but every version the base released stays listed with the digest it was released as.
 */
async function droppedReleases(root: string, diff: BaseDiff): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const path of diff.paths) {
    const parts = path.split("/");
    if (parts.length !== 5 || parts[0] !== "artifacts" || parts[4] !== VERSIONS_DOCUMENT) continue;
    const now = await readDocument(root, path);
    const gone = now === undefined && !(await exists(join(root, ...path.split(posix.sep))));
    if (now === undefined && !gone) continue;
    const listed = rowsOf(now);
    for (const [version, digest] of await diff.released(path)) {
      if (listed.get(version) === digest) continue;
      problems.push({
        path,
        message: gone
          ? `is missing, but ${version} was released`
          : listed.has(version)
            ? `changes the digest of ${version}, which was released as ${String(digest)}`
            : `no longer lists ${version}, which was released`,
        fix: gone ? `git checkout ${diff.ref} -- ${posix.dirname(path)}; ${WITHDRAW}` : undefined,
      });
    }
  }
  return problems;
}

/** Rule 7: nothing is erased, so a release is withdrawn by yanking it. */
const WITHDRAW = 'to withdraw a release, set "yanked": true in its versions.json instead';

/** What `<kind> init` could not fill in, and an author has not yet. */
const PLACEHOLDER = "TODO";

function placeholders(value: unknown, at = ""): string[] {
  if (value === PLACEHOLDER) return [at];
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    placeholders(item, at === "" ? key : `${at}.${key}`),
  );
}

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
  const problems = missingFiles(manifest, present).map(
    (missing) =>
      `has no ${missing}, which ${/^[aeiou]/.test(at.kind) ? "an" : "a"} ${at.kind} needs`,
  );
  const spec = specOf(manifest, contents);
  if (spec === undefined) return [...problems, "has no front matter to read its fields from"];
  problems.push(...check(manifest, spec));
  for (const field of placeholders(spec)) problems.push(`\`${field}\` is still ${PLACEHOLDER}`);
  if (typeof spec.name === "string" && spec.name !== at.name) {
    problems.push(`is named ${quoted(spec.name)} in its front matter but sits in ${at.name}/`);
  }
  return problems;
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

function artifactOf(folder: Folder): string {
  return `${folder.namespace}/${folder.kind}/${folder.name}`;
}

/** The newest version folder of each artifact, by SemVer precedence. */
function newestFolders(folders: readonly Folder[]): Map<string, string> {
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

/** One version folder's problems, and whether the index no longer lists it. */
async function folderProblems(
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
  // Released: the envelope must still describe exactly the bytes it was released with.
  if (releasedHere !== undefined) return { problems, stale: false };
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

/**
 * Everything a pull request could get wrong: path grammar, documents, digests, kind manifests,
 * released versions left alone, and an index matching what the indexer would write.
 */
export async function validateRoot(
  root: string,
  options: { base?: string | undefined } = {},
): Promise<Validated> {
  const problems: Problem[] = [];
  let name = "registry";
  let blobUrl = DEFAULT_BLOB_URL;
  try {
    const registry = await readRegistry(rootReader(root));
    name = registry.slug ?? registry.name;
    blobUrl = registry.blobUrl;
    if (!registry.capabilities.includes("files")) {
      problems.push({ path: REGISTRY_DOCUMENT, message: 'capabilities must include "files"' });
    }
  } catch (error) {
    problems.push({ path: REGISTRY_DOCUMENT, message: (error as Error).message });
  }
  const index = await jsonAt(root, INDEX_DOCUMENT, problems);
  if (index === undefined && !problems.some((p) => p.path === INDEX_DOCUMENT)) {
    problems.push({ path: INDEX_DOCUMENT, message: "is missing", fix: "aireg registry index" });
  }

  await layout(root, problems);
  const kinds = await kindsOf(root);
  problems.push(...(await manifestProblems(root)));
  const diff = options.base === undefined ? undefined : await baseDiff(root, options.base);
  const released = diff === undefined ? new Map() : await releasedChanges(diff);
  if (diff !== undefined) problems.push(...(await droppedReleases(root, diff)));
  const folders = await versionFolders(root);
  const held = new Set(
    folders.map((folder) => `${folder.namespace}/${folder.kind}/${folder.name}@${folder.version}`),
  );
  const newest = newestFolders(folders);
  const artifacts = new Set<string>();
  const namespaces = new Set<string>();
  const listings = new Map<string, Map<string, unknown>>();
  let stale = false;

  for (const folder of folders) {
    namespaces.add(folder.namespace);
    artifacts.add(`${folder.namespace}/${folder.kind}/${folder.name}`);
    const checked = await folderProblems(root, folder, {
      kinds,
      held,
      released,
      listings,
      blobUrl,
      restoreFrom: diff?.ref ?? "HEAD",
      newest,
    });
    problems.push(...checked.problems);
    if (checked.stale) stale = true;
  }

  const listedIn = new Set(
    (
      ((index as { entries?: unknown } | undefined)?.entries ?? []) as {
        namespace?: string;
        kind?: string;
        name?: string;
      }[]
    ).map((entry) => `${entry.namespace}/${entry.kind}/${entry.name}`),
  );
  for (const artifact of artifacts) if (!listedIn.has(artifact)) stale = true;
  problems.push(...(await catalogProblems(root, held, index)));
  if (stale) {
    problems.push({ path: INDEX_DOCUMENT, message: "is out of date", fix: "aireg registry index" });
  }

  return {
    name,
    namespaces: namespaces.size,
    artifacts: artifacts.size,
    versions: folders.length,
    problems,
  };
}

/** Every `<namespace>/<kind>/<name>` that has a `versions.json`, whether or not a version folder is left. */
async function catalogued(root: string): Promise<string[]> {
  const found: string[] = [];
  const base = join(root, "artifacts");
  for (const namespace of (await subdirectories(base)).filter(isNamespace)) {
    for (const kind of (await subdirectories(join(base, namespace))).filter(isKindSegment)) {
      for (const name of await subdirectories(join(base, namespace, kind))) {
        if (!isArtifactName(name)) continue;
        if (await exists(join(base, namespace, kind, name, VERSIONS_DOCUMENT))) {
          found.push(`${namespace}/${kind}/${name}`);
        }
      }
    }
  }
  return found;
}

/** Section 3: the documents describe one catalog, so they must agree. */
async function catalogProblems(
  root: string,
  held: ReadonlySet<string>,
  index: unknown,
): Promise<Problem[]> {
  const rows = new Map<string, Record<string, unknown>>();
  const entries = (index as { entries?: unknown } | undefined)?.entries;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = entry as Record<string, unknown>;
    rows.set(`${row.namespace}/${row.kind}/${row.name}`, row);
  }
  const problems: Problem[] = [];
  const keys = await catalogued(root);
  for (const key of keys) {
    const [namespace = "", kind = "", name = ""] = key.split("/");
    const at = versionsPath(namespace, kind, name);
    const document = await readDocument(root, at);
    if (document === undefined) continue;
    problems.push(...versionsProblems(at, document, { namespace, kind, name }));
    problems.push(...(await rowProblems(root, at, key, document, held)));
    problems.push(...indexRowProblems(key, rows.get(key), document));
  }
  const kept = new Set(keys);
  for (const key of rows.keys()) {
    if (kept.has(key)) continue;
    problems.push({
      path: INDEX_DOCUMENT,
      message: `lists ${key}, which has no versions.json`,
      fix: "aireg registry index",
    });
  }
  return problems;
}

/** Rule 1: every listed version keeps its folder, and a `catalog_digest` covers its row. */
async function rowProblems(
  root: string,
  at: string,
  key: string,
  document: Record<string, unknown>,
  held: ReadonlySet<string>,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const versions = Array.isArray(document.versions) ? document.versions : [];
  for (const row of versions) {
    if (!isRecord(row) || typeof row.version !== "string" || !isVersion(row.version)) continue;
    const folder = `${posix.dirname(at)}/${row.version}`;
    if (!held.has(`${key}@${row.version}`)) {
      problems.push({
        path: folder,
        message: `is missing, but versions.json lists ${row.version}`,
        fix: `restore ${folder}/, or if ${row.version} was never released, remove it from versions.json`,
      });
      continue;
    }
    if (typeof row.catalog_digest !== "string") continue;
    const envelope = await readJson(rootReader(root), `${folder}/${ENVELOPE}`).catch(
      () => undefined,
    );
    if (!isRecord(envelope) || !isRecord(envelope.metadata)) continue;
    const want = catalogDigest(envelope as unknown as Envelope, row);
    if (row.catalog_digest === want) continue;
    // With the content as released, only the row's status moved it, and indexing recomputes it.
    const indexed = contentDigest(envelope as unknown as Envelope) === row.digest;
    problems.push({
      path: at,
      message: `catalog_digest of ${row.version} is ${row.catalog_digest}, but its row and envelope give ${want}`,
      ...(indexed ? { fix: "aireg registry index" } : {}),
    });
  }
  return problems;
}

async function readDocument(
  root: string,
  at: string,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readJson(rootReader(root), at).catch(() => undefined);
  return isRecord(raw) ? raw : undefined;
}

/** A `versions.json` names its own folder and the newest active release. */
function versionsProblems(
  at: string,
  document: Record<string, unknown>,
  named: Record<"namespace" | "kind" | "name", string>,
): Problem[] {
  const problems: Problem[] = [];
  for (const [field, folder] of Object.entries(named)) {
    if (document[field] !== folder) {
      problems.push({
        path: at,
        message: `${field} is ${String(document[field])}, but its folder says ${folder}`,
      });
    }
  }
  const want = newest(Array.isArray(document.versions) ? document.versions : []);
  if (want !== undefined && document.latest !== want) {
    problems.push({
      path: at,
      message: `latest is ${String(document.latest)}, but the newest active release is ${want}`,
      fix: "aireg registry index",
    });
  }
  return problems;
}

/** The `index.json` row repeats the release `versions.json` calls latest, and its digest. */
function indexRowProblems(
  key: string,
  row: Record<string, unknown> | undefined,
  document: Record<string, unknown>,
): Problem[] {
  if (row === undefined) return [];
  const fix = "aireg registry index";
  if (row.latest !== document.latest) {
    return [
      {
        path: INDEX_DOCUMENT,
        message: `${key} latest is ${String(row.latest)}, but versions.json says ${String(document.latest)}`,
        fix,
      },
    ];
  }
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const pinned = versions.find(
    (item) => (item as { version?: unknown }).version === document.latest,
  ) as { digest?: unknown } | undefined;
  if (pinned === undefined || row.digest === pinned.digest) return [];
  return [
    {
      path: INDEX_DOCUMENT,
      message: `${key} digest is ${String(row.digest)}, but versions.json says ${String(pinned.digest)}`,
      fix,
    },
  ];
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
