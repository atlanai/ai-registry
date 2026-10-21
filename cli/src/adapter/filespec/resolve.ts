import {
  type Artifact,
  covers,
  type FileRef,
  type Newest,
  type Resolution,
  type Want,
  type Withheld,
} from "../contract.ts";
import type { ArtifactKind } from "../kinds.ts";
import { collidingPaths, isSafePath } from "../paths.ts";
import { contentDigest } from "../spec/canonical.ts";
import { digestHex } from "../spec/ref.ts";
import type { Envelope, FileDescriptor } from "../spec/types.ts";
import { quoted } from "../text.ts";
import {
  type IndexRow,
  newestListed,
  object,
  type ReadPath,
  readIndex,
  readJson,
  readVersions,
  resolveVersion,
  SpecError,
  type VersionRow,
} from "./documents.ts";
import {
  ENVELOPE,
  INDEX_DOCUMENT,
  isArtifactName,
  isNamespace,
  isVersion,
  versionDir,
} from "./names.ts";

/** Each descriptor is checked and kept as written, since the content digest covers all of it. */
function checkFiles(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new SpecError(`${path} has no \`files\` list.`, { path });
  const files = value.map((item, at) => {
    const file = object(item, `${path} files[${at}]`);
    if (typeof file.path !== "string" || typeof file.digest !== "string") {
      throw new SpecError(`\`files[${at}]\` in ${path} needs a path and a digest.`, { path });
    }
    if (typeof file.size !== "number" || !Number.isInteger(file.size)) {
      throw new SpecError(`\`files[${at}]\` in ${path} needs a whole-number size.`, { path });
    }
    if (
      file.urls !== undefined &&
      !(Array.isArray(file.urls) && file.urls.every((url) => typeof url === "string"))
    ) {
      throw new SpecError(`\`files[${at}]\` in ${path} needs \`urls\` to be a list of strings.`, {
        path,
      });
    }
    if (!isSafePath(file.path)) {
      throw new SpecError(
        `\`files[${at}]\` in ${path} names ${quoted(file.path)}, which is not a path inside the artifact.`,
        { path },
      );
    }
    return file.path;
  });
  const clash = collidingPaths(files);
  if (clash !== undefined) {
    throw new SpecError(
      `${path} names ${quoted(clash[0])} and ${quoted(clash[1])}, which are one file on most disks.`,
      { path },
    );
  }
}

/**
 * The envelope as the root wrote it, never rebuilt: its digest is what a version
 * is pinned by, so recomputing it from parts would let a rewrite pass unnoticed.
 */
async function readEnvelope(
  read: ReadPath,
  namespace: string,
  kind: ArtifactKind,
  name: string,
  version: string,
  expected: string,
): Promise<Envelope> {
  const dir = versionDir(namespace, kind, name, version);
  const path = `${dir}/${ENVELOPE}`;
  const parsed = await readJson(read, path);
  if (parsed === undefined) throw new SpecError(`${path} is missing.`, { path, missing: true });
  const raw = object(parsed, path);
  const metadata = object(raw.metadata, `${path} metadata`);

  // Section 3.4: the envelope's own idea of where it lives must equal where it
  // was found, or one of the two is lying about what was pinned.
  if (raw.kind !== kind) {
    throw new SpecError(
      `${path} says kind ${quoted(String(raw.kind))}, but it is under ${quoted(kind)}.`,
      { path },
    );
  }
  for (const [key, want] of Object.entries({ namespace, name, version })) {
    const got = metadata[key];
    if (got !== want) {
      throw new SpecError(
        `${path} says ${key} ${quoted(String(got))}, but it is under ${quoted(want)}.`,
        { path },
      );
    }
  }

  if (typeof raw.apiVersion !== "string") {
    throw new SpecError(`${path} has no \`apiVersion\`.`, { path });
  }
  checkFiles(raw.files, path);
  if (raw.spec !== undefined) object(raw.spec, `${path} spec`);
  if (raw.relationships !== undefined && !Array.isArray(raw.relationships)) {
    throw new SpecError(`${path} needs \`relationships\` to be a list.`, { path });
  }
  // Unknown fields stay, since rule 4 says a reader ignores them and the digest covers them.
  const envelope = raw as unknown as Envelope;

  // Section 6: verify the content digest equals the one the versions document
  // named. Every mirror, CDN and host is untrusted; the client checks.
  const actual = contentDigest(envelope);
  if (actual !== expected) {
    throw new SpecError(
      `${path} does not match its digest: versions.json says ${expected}, but it hashes to ${actual}.`,
      { path },
    );
  }
  return envelope;
}

/** A url with a scheme is on another host; any other resolves inside the root (section 11). */
export function isRemote(url: string): boolean {
  return url.includes("://");
}

/** Where one described file is read from, relative to the root. */
export function locatorOf(descriptor: FileDescriptor, dir: string, blobUrl: string): string {
  const relative = descriptor.urls?.find((url) => !isRemote(url));
  if (relative !== undefined) return `${dir}/${relative}`;
  // Section 3.6: no relative url means the blob store, addressed by digest.
  return blobUrl.replace("{digest}", digestHex(descriptor.digest));
}

/** Whether every file sits in the version directory, so it can be read where it lies. */
export function besideEnvelope(artifact: Artifact): boolean {
  return artifact.files.every((file) => file.locator === `${artifact.id}/${file.path}`);
}

function refsOf(envelope: Envelope, dir: string, blobUrl: string): FileRef[] {
  return envelope.files.map((descriptor) => ({
    path: descriptor.path,
    locator: locatorOf(descriptor, dir, blobUrl),
    executable: false,
  }));
}

/** What `resolveFromRoot` reads and how. */
export interface RootResolveOptions {
  /** `blob_url` from `registry.json`, already defaulted. */
  blobUrl: string;
  /** What the caller asked for. Empty means everything the index lists, at latest. */
  wanted: readonly Want[];
  /** Everything the index lists, with `wanted` applying only as pins. */
  all?: boolean | undefined;
}

const narrowness = (want: Want) =>
  Number(want.namespace !== undefined) + Number(want.kind !== undefined);

/** Where two wants reach one artifact, the one that names it more narrowly sets its version. */
function pinOf(reaching: readonly Want[]): string | undefined {
  return [...reaching]
    .filter((want) => want.version !== undefined)
    .sort((a, b) => narrowness(b) - narrowness(a))[0]?.version;
}

const UNRELEASED = new Set(["draft", "pending_review"]);

/** Statuses that install, but with a warning the client gives from `Artifact.status`. */
const CAUTIONED = new Set([...UNRELEASED, "deprecated", "archived"]);

function usable(entry: IndexRow): boolean {
  return isNamespace(entry.namespace) && isArtifactName(entry.name) && isVersion(entry.latest);
}

/**
 * Two round trips resolve a ref to bytes: the versions document, then the envelope and
 * the files it names. A name the caller did not ask for is never read.
 */
export async function resolveFromRoot(
  read: ReadPath,
  options: RootResolveOptions,
): Promise<Resolution> {
  const index = await readIndex(read);
  // A want this index does not list is left to the caller: refusing it here
  // would break the very push that is waiting to be indexed.
  const chosen = index.flatMap((entry) => {
    const reaching = options.wanted.filter((want) => covers(want, entry));
    const asked = reaching.length > 0;
    if (options.all !== true && options.wanted.length > 0 && !asked) return [];
    return [{ entry, asked, pinned: pinOf(reaching) }];
  });

  const rows = await inOrder(chosen, async ({ entry, asked, pinned }) => {
    // A malformed path segment is the indexer's mistake, and installing from
    // it would write that mistake into somebody's tree.
    if (!usable(entry)) {
      throw new SpecError(
        `index.json lists ${quoted(`${entry.namespace}/${entry.kind}/${entry.name}@${entry.latest}`)}, which is not a valid path.`,
        { path: INDEX_DOCUMENT },
      );
    }

    const versions = await readVersions(read, entry.namespace, entry.kind, entry.name);
    const version = resolveVersion(versions, pinned);
    const held: Withheld[] = [];
    const served = await serve(read, { entry, version, asked, pinned }, held, options.blobUrl);

    const reported =
      served !== undefined || heldBack(version, pinned) ? version.version : undefined;
    const top = newestListed(versions);
    const { namespace, kind, name } = entry;
    const newest: Newest | undefined =
      reported === top ? undefined : { namespace, kind, name, version: top };
    return { served, held, newest };
  });
  const withheld = rows.flatMap((row) => row.held);
  const newest = rows.flatMap((row) => (row.newest === undefined ? [] : [row.newest]));

  return {
    artifacts: rows.flatMap((row) => (row.served === undefined ? [] : [row.served])),
    ...(withheld.length === 0 ? {} : { withheld }),
    ...(newest.length === 0 ? {} : { newest }),
  };
}

function heldBack(version: VersionRow, pinned: string | undefined): boolean {
  const status = version.status ?? "";
  return status === "blocked" || (pinned === undefined && UNRELEASED.has(status));
}

async function serve(
  read: ReadPath,
  {
    entry,
    version,
    asked,
    pinned,
  }: { entry: IndexRow; version: VersionRow; asked: boolean; pinned: string | undefined },
  withheld: Withheld[],
  blobUrl: string,
): Promise<Artifact | undefined> {
  // Section 5 rule 7: a yanked version stays resolvable by name, because a
  // lockfile pinning one must keep resolving, but `latest` must not hand it out.
  if (version.yanked && pinned === undefined) return undefined;

  const status = version.status ?? "";
  if (heldBack(version, pinned)) {
    const { namespace, kind, name } = entry;
    withheld.push({
      namespace,
      kind,
      name,
      version: version.version,
      status,
      reason: version.reason,
    });
    return undefined;
  }
  // An archived artifact is retired: named, it still installs, but taking a
  // whole namespace does not bring it along.
  if (version.status === "archived" && !asked) return undefined;

  const dir = versionDir(entry.namespace, entry.kind, entry.name, version.version);
  const envelope = await readEnvelope(
    read,
    entry.namespace,
    entry.kind,
    entry.name,
    version.version,
    version.digest,
  );
  return {
    id: dir,
    kind: entry.kind,
    group: entry.namespace,
    envelope,
    files: refsOf(envelope, dir, blobUrl),
    ...(version.yanked ? { yanked: { reason: version.reason } } : {}),
    ...(CAUTIONED.has(status) ? { status: { name: status, reason: version.reason } } : {}),
  } satisfies Artifact;
}

/** Entries read at once, up to this many: a registry of thousands is not read one by one. */
const READS_AT_ONCE = 16;

/**
 * `work` over every item, a few at a time, with results in the items' order. A failure
 * is the first item's that failed, as a one-by-one pass would have reported it.
 */
async function inOrder<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const failures = new Map<number, unknown>();
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      try {
        results[at] = await work(items[at] as T);
      } catch (error) {
        failures.set(at, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, lane));
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}
