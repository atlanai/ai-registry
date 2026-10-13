import { join, posix } from "node:path";
import { hashRegular, readRegular } from "#adapter/files.ts";
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
  isKindSegment,
  isNamespace,
  isVersion,
  REGISTRY_DOCUMENT,
  versionDir,
  versionsPath,
} from "#adapter/filespec/names.ts";
import { isRemote, locatorOf } from "#adapter/filespec/resolve.ts";
import {
  mergedIndex,
  mergedVersions,
  newest,
  type OfferedVersion,
  specJson,
} from "#adapter/filespec/write.ts";
import {
  type ArtifactKind,
  buildEnvelope,
  contentDigest,
  type Envelope,
  type EnvelopeMetadata,
  type FileDescriptor,
  sha256,
} from "#adapter/index.ts";
import { catalogDigest } from "#adapter/spec/canonical.ts";
import { describeFile } from "#adapter/spec/envelope.ts";
import { isDigest } from "#adapter/spec/ref.ts";
import { ownDescription } from "#core/catalog/frontmatter.ts";
import { isRecord } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { authored, exists, refusal, subdirectories } from "#core/fs/tree.ts";
import { withLease } from "#core/lease.ts";
import { envelopeSpec, type KindManifest, kindsOf } from "./kinds.ts";

/** One version folder, as the path grammar reads it. */
export interface VersionFolder {
  namespace: string;
  kind: string;
  name: string;
  version: string;
  /** Root-relative, POSIX. */
  at: string;
}

export interface Indexed {
  added: OfferedVersion[];
  /** Artifacts whose `latest` moved without a new version, such as after a yank. */
  moved: OfferedVersion[];
  /** Root-relative paths written. */
  paths: string[];
}

/** Every folder under `artifacts/` shaped like `<namespace>/<kind>/<name>/<version>`. */
export async function versionFolders(root: string): Promise<VersionFolder[]> {
  const found: VersionFolder[] = [];
  const base = join(root, "artifacts");
  for (const namespace of (await subdirectories(base)).filter(isNamespace)) {
    for (const kind of (await subdirectories(join(base, namespace))).filter(isKindSegment)) {
      for (const name of (await subdirectories(join(base, namespace, kind))).filter(
        isArtifactName,
      )) {
        for (const version of (await subdirectories(join(base, namespace, kind, name))).filter(
          isVersion,
        )) {
          found.push({
            namespace,
            kind,
            name,
            version,
            at: versionDir(namespace, kind, name, version),
          });
        }
      }
    }
  }
  return found;
}

function json(root: string, path: string): Promise<unknown | undefined> {
  return readJson(rootReader(root), path);
}

/**
 * Versions a `versions.json` already lists, with their digests. `cache` keeps one read per
 * artifact for a run, since reading it per version folder would be quadratic.
 */
export async function listed(
  root: string,
  folder: VersionFolder,
  cache?: Map<string, Map<string, unknown>>,
): Promise<Map<string, unknown>> {
  const at = versionsPath(folder.namespace, folder.kind, folder.name);
  const kept = cache?.get(at);
  if (kept !== undefined) return kept;
  const found = await listedNow(root, at);
  cache?.set(at, found);
  return found;
}

async function listedNow(root: string, at: string): Promise<Map<string, unknown>> {
  const raw = await json(root, at);
  const rows = (raw as { versions?: unknown } | undefined)?.versions;
  return new Map(
    Array.isArray(rows)
      ? rows.flatMap((row) => {
          const { version, digest } = row as { version?: unknown; digest?: unknown };
          return typeof version === "string" ? [[version, digest] as const] : [];
        })
      : [],
  );
}

/**
 * Only a Markdown or JSON file can hold the spec or a description, so only those
 * are held; any other file is digested as it streams past, however large.
 */
async function digested(dir: string, path: string) {
  if (!/\.(md|json)$/.test(path)) {
    const read = await hashRegular(dir, path);
    return read.kind === "file" ? { ...read, bytes: new Uint8Array() } : read;
  }
  const read = await readRegular(dir, path);
  if (read.kind !== "file") return read;
  return {
    kind: "file" as const,
    digest: sha256(read.bytes),
    size: read.bytes.byteLength,
    bytes: read.bytes,
  };
}

/** A descriptor with no relative url, whose bytes the blob store holds (section 3.6). */
export function inBlobStore(file: unknown): file is FileDescriptor {
  if (!isRecord(file) || typeof file.path !== "string" || typeof file.digest !== "string") {
    return false;
  }
  if (!isDigest(file.digest) || !Number.isSafeInteger(file.size)) return false;
  const urls = file.urls;
  if (urls === undefined) return true;
  return Array.isArray(urls) && urls.every((url) => typeof url === "string" && isRemote(url));
}

/** Why the blob store does not hold the bytes `file` names at `locator`, if it does not. */
async function blobProblem(
  root: string,
  file: FileDescriptor,
  locator: string,
): Promise<string | undefined> {
  const read = await hashRegular(root, locator).catch(() => undefined);
  if (read === undefined) return "could not be read";
  if (read.kind === "missing") return "is missing";
  if (read.kind === "refused") return read.reason;
  return read.digest === file.digest && read.size === file.size ? undefined : "holds other bytes";
}

/**
 * Files an existing `artifact.json` keeps in the blob store, which no folder holds:
 * carried into the new envelope once the blob is there with the bytes they name.
 */
async function blobFiles(
  root: string,
  folder: VersionFolder,
  existing: unknown,
  onDisk: ReadonlySet<string>,
  blobUrl: string,
): Promise<FileDescriptor[]> {
  const files = isRecord(existing) && Array.isArray(existing.files) ? existing.files : [];
  const kept = files.filter((file) => inBlobStore(file) && !onDisk.has(file.path));
  // A blob on another host is verified by whoever fetches it.
  if (isRemote(blobUrl)) return kept;
  for (const file of kept) {
    const locator = locatorOf(file, folder.at, blobUrl);
    const problem = await blobProblem(root, file, locator);
    if (problem !== undefined) {
      throw new SpecError(
        `${folder.at}/${ENVELOPE} keeps ${file.path} in the blob store, but ${locator} ${problem}.`,
        { path: locator },
      );
    }
  }
  return kept;
}

/**
 * The envelope a version folder should carry: its files described and digested,
 * with anything an author added to an existing `artifact.json` kept.
 */
async function envelopeOf(
  root: string,
  folder: VersionFolder,
  kinds: Readonly<Record<string, KindManifest>>,
  blobUrl: string,
) {
  const dir = join(root, ...folder.at.split(posix.sep));
  const found = await authored(dir);
  const [refused] = found.irregular;
  if (refused !== undefined) {
    const at = `${folder.at}/${refused.path}`;
    throw new SpecError(`${at} ${refusal(refused)}.`, { path: at });
  }
  const records = found.files.filter((record) => record.path !== ENVELOPE);
  if (records.length === 0)
    throw new SpecError(`${folder.at} holds no files.`, { path: folder.at });
  // Every path is kept, so the description sees how many files there are.
  const bytes = new Map<string, Uint8Array>();
  const files: FileDescriptor[] = [];
  for (const record of records) {
    const read = await digested(dir, record.path);
    if (read.kind !== "file") {
      const at = `${folder.at}/${record.path}`;
      throw new SpecError(`${at} ${read.kind === "missing" ? "is missing" : read.reason}.`, {
        path: at,
      });
    }
    bytes.set(record.path, read.bytes);
    files.push(describeFile(record.path, read.digest, read.size));
  }
  const existing = (await json(root, `${folder.at}/${ENVELOPE}`)) as
    | { metadata?: Partial<EnvelopeMetadata>; spec?: unknown; relationships?: unknown }
    | undefined;
  const onDisk = new Set(records.map((record) => record.path));
  files.push(...(await blobFiles(root, folder, existing, onDisk, blobUrl)));
  const { digest: _digest, ...kept } = existing?.metadata ?? {};
  const description = ownDescription(bytes, folder.name) ?? kept.description;
  return buildEnvelope({
    kind: folder.kind as ArtifactKind,
    metadata: {
      ...kept,
      name: folder.name,
      namespace: folder.namespace,
      version: folder.version,
      ...(description === undefined ? {} : { description }),
    },
    files,
    spec:
      existing?.spec === undefined
        ? envelopeSpec(folder.kind, bytes, kinds)
        : (existing.spec as Record<string, unknown>),
    ...(Array.isArray(existing?.relationships)
      ? { relationships: existing.relationships as never }
      : {}),
  });
}

/**
 * One writer at a time per registry folder, the same key a local publish takes.
 * The lease lives in aireg's home, keeping the registry clean.
 */
function withRegistryLease<T>(root: string, run: () => Promise<T>): Promise<T> {
  return withLease({ scope: "user", lock: join(root, REGISTRY_DOCUMENT) }, { wait: true }, run);
}

/**
 * Every version folder `versions.json` does not list yet gets an `artifact.json`, a row there and
 * an `index.json` entry. Listed versions are released and never touched.
 */
export function indexRoot(root: string, at: string): Promise<Indexed> {
  return withRegistryLease(root, () => indexRootNow(root, at));
}

async function indexRootNow(root: string, at: string): Promise<Indexed> {
  const added: OfferedVersion[] = [];
  const paths: string[] = [];
  const latest = new Map<string, OfferedVersion>();
  const folders = await versionFolders(root);
  const documents = new Set(
    folders.map((folder) => versionsPath(folder.namespace, folder.kind, folder.name)),
  );
  for (const versionsAt of documents) {
    if (await recatalog(root, versionsAt)) paths.push(versionsAt);
  }
  const kinds = await kindsOf(root);
  const listings = new Map<string, Map<string, unknown>>();
  const pending = new Map<string, unknown>();
  const blobUrl = await readRegistry(rootReader(root)).then(
    (registry) => registry.blobUrl,
    () => DEFAULT_BLOB_URL,
  );
  for (const folder of folders) {
    if ((await listed(root, folder, listings)).has(folder.version)) continue;
    const envelope = await envelopeOf(root, folder, kinds, blobUrl);
    const digest = envelope.metadata.digest as string;
    await writeAtomic(join(root, ...folder.at.split(posix.sep), ENVELOPE), specJson(envelope));
    const offered: OfferedVersion = {
      namespace: folder.namespace,
      kind: folder.kind as ArtifactKind,
      name: folder.name,
      version: folder.version,
      digest,
      ...(envelope.metadata.description === undefined
        ? {}
        : { description: envelope.metadata.description }),
    };
    const versionsAt = versionsPath(folder.namespace, folder.kind, folder.name);
    // Written once per run, so indexing stays linear in the number of versions.
    const current = pending.has(versionsAt)
      ? pending.get(versionsAt)
      : await json(root, versionsAt);
    const versions = mergedVersions(current, offered, at);
    pending.set(versionsAt, versions);
    listings.get(versionsAt)?.set(offered.version, offered.digest);
    if (versions.latest === offered.version) latest.set(versionsAt, offered);
    added.push(offered);
    paths.push(`${folder.at}/${ENVELOPE}`);
  }
  for (const [versionsAt, document] of pending) {
    await writeAtomic(join(root, ...versionsAt.split(posix.sep)), specJson(document));
    paths.push(versionsAt);
  }
  // A yank or a hand edit leaves `latest` behind without adding a version, so
  // every artifact's is recomputed, not only those just indexed.
  const moved: OfferedVersion[] = [];
  for (const versionsAt of documents) {
    if (latest.has(versionsAt)) continue;
    const found = await currentLatest(root, versionsAt);
    if (found === undefined) continue;
    latest.set(versionsAt, found.offered);
    if (!found.moved) continue;
    await writeAtomic(join(root, ...versionsAt.split(posix.sep)), specJson(found.document));
    moved.push(found.offered);
    paths.push(versionsAt);
  }
  const existing = await json(root, INDEX_DOCUMENT);
  const index = await withoutDeleted(root, mergedIndex(existing, [...latest.values()], at), at);
  if (added.length > 0 || specJson(index) !== specJson(existing)) {
    await writeAtomic(join(root, INDEX_DOCUMENT), specJson(index));
    paths.push(INDEX_DOCUMENT);
  }
  return { added, moved, paths: [...new Set(paths)] };
}

/**
 * Section 9: a status change moves its row's `catalog_digest` too (section 4.3). Only a row
 * whose envelope still has its content digest is recomputed, so changed content stays an error.
 */
async function recatalog(root: string, versionsAt: string): Promise<boolean> {
  const document = await json(root, versionsAt).catch(() => undefined);
  if (!isRecord(document) || !Array.isArray(document.versions)) return false;
  const rows: unknown[] = document.versions;
  const versions: unknown[] = [];
  for (const row of rows) versions.push(await recataloged(root, versionsAt, row));
  if (versions.every((row, at) => row === rows[at])) return false;
  await writeAtomic(
    join(root, ...versionsAt.split(posix.sep)),
    specJson({ ...document, versions }),
  );
  return true;
}

async function recataloged(root: string, versionsAt: string, row: unknown): Promise<unknown> {
  if (!isRecord(row) || typeof row.catalog_digest !== "string") return row;
  if (typeof row.version !== "string" || !isVersion(row.version)) return row;
  const envelope = await json(
    root,
    `${posix.dirname(versionsAt)}/${row.version}/${ENVELOPE}`,
  ).catch(() => undefined);
  if (!isRecord(envelope) || !isRecord(envelope.metadata)) return row;
  if (contentDigest(envelope as unknown as Envelope) !== row.digest) return row;
  const want = catalogDigest(envelope as unknown as Envelope, row);
  return want === row.catalog_digest ? row : { ...row, catalog_digest: want };
}

/** An artifact whose `versions.json` is gone has nothing left to list. */
async function withoutDeleted(
  root: string,
  index: Record<string, unknown>,
  at: string,
): Promise<Record<string, unknown>> {
  const entries = index.entries as Record<string, unknown>[];
  const kept: Record<string, unknown>[] = [];
  for (const row of entries) {
    const path = versionsPath(String(row.namespace), String(row.kind), String(row.name));
    if (await exists(join(root, ...path.split(posix.sep)))) kept.push(row);
  }
  return kept.length === entries.length ? index : { ...index, generated_at: at, entries: kept };
}

/**
 * One artifact's newest active release, with its `versions.json` set to name it. With none
 * active, `latest` stays where it is and its row's status still reaches the index.
 */
async function currentLatest(
  root: string,
  versionsAt: string,
): Promise<
  { offered: OfferedVersion; document: Record<string, unknown>; moved: boolean } | undefined
> {
  const raw = await json(root, versionsAt);
  if (typeof raw !== "object" || raw === null) return undefined;
  const document = raw as Record<string, unknown>;
  const rows = Array.isArray(document.versions) ? (document.versions as unknown[]) : [];
  const version =
    newest(rows) ?? (typeof document.latest === "string" ? document.latest : undefined);
  const row = rows.find((item) => (item as { version?: unknown }).version === version) as
    | { digest?: unknown; status?: unknown; catalog_digest?: unknown }
    | undefined;
  if (version === undefined || typeof row?.digest !== "string") return undefined;
  const [, namespace = "", kind = "", name = ""] = versionsAt.split(posix.sep);
  const envelope = (await json(
    root,
    `${versionsAt.replace(/versions\.json$/, version)}/${ENVELOPE}`,
  )) as { metadata?: { description?: unknown } } | undefined;
  const description = envelope?.metadata?.description;
  return {
    offered: {
      namespace,
      kind: kind as ArtifactKind,
      name,
      version,
      digest: row.digest,
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}),
      ...(typeof row.catalog_digest === "string" ? { catalogDigest: row.catalog_digest } : {}),
    },
    document: { ...document, latest: version },
    moved: document.latest !== version,
  };
}
