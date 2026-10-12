import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  buildEnvelope,
  bumpVersion,
  compareVersion,
  describeFile,
  ENVELOPE,
  type Envelope,
  type FileDescriptor,
  formatVersion,
  INDEX_DOCUMENT,
  isArtifactName,
  isDeviceName,
  isKindSegment,
  isNamespace,
  isVersion,
  mergedIndex,
  mergedVersions,
  type OfferedVersion,
  type PublishInput,
  parseVersion,
  quoted,
  REGISTRY_DOCUMENT,
  type ReadPath,
  readJson,
  rootReader,
  type SourceContext,
  SpecError,
  sha256,
  specJson,
  versionDir,
  versionsPath,
  writeAtomic,
} from "#adapter/index.ts";

export interface WrittenOffer {
  /** Every version offered already sat in the root with this exact digest. */
  unchanged: boolean;
}

function destination(change: PublishInput): { namespace: string; version: string; at: string } {
  const { namespace, version, kind, name } = change;
  if (namespace === undefined || version === undefined) {
    throw new SpecError(
      `${name} has no namespace or version, so there is no path in the registry to offer it at.`,
      { path: name },
    );
  }
  // These become path segments. The reader refuses anything else, and a value
  // that climbs out of the root must never reach `join`.
  if (!isNamespace(namespace))
    throw new SpecError(`${quoted(namespace)} is not a namespace.`, { path: name });
  if (!isKindSegment(kind)) throw new SpecError(`${quoted(kind)} is not a kind.`, { path: name });
  if (!isArtifactName(name))
    throw new SpecError(`${quoted(name)} is not a valid artifact name.`, { path: name });
  if (!isVersion(version))
    throw new SpecError(`${quoted(version)} is not a version.`, { path: name });
  const device = [namespace, kind, name, version].find(isDeviceName);
  if (device !== undefined)
    throw new SpecError(`${quoted(device)} is a device name on Windows.`, { path: name });
  return { namespace, version, at: versionDir(namespace, kind, name, version) };
}

function envelopeFor(change: PublishInput, files: readonly FileDescriptor[]): Envelope {
  return buildEnvelope({
    kind: change.kind,
    metadata: {
      name: change.name,
      ...(change.namespace === undefined ? {} : { namespace: change.namespace }),
      ...(change.version === undefined ? {} : { version: change.version }),
      ...(change.description === undefined ? {} : { description: change.description }),
    },
    files,
    spec: change.spec,
  });
}

function sealed(
  change: PublishInput,
  files: readonly FileDescriptor[],
): { envelope: Envelope; digest: string } {
  const envelope = envelopeFor(change, files);
  const digest = envelope.metadata.digest;
  if (digest === undefined) {
    throw new SpecError(`${change.name} produced no content digest.`, { path: change.name });
  }
  return { envelope, digest };
}

function descriptorsOf(change: PublishInput): FileDescriptor[] {
  return change.files.map((file) =>
    describeFile(file.path, sha256(file.content), file.content.byteLength),
  );
}

function under(root: string, path: string): string {
  return join(root, ...path.split(posix.sep));
}

/** Versions `versions.json` lists for one artifact, oldest first. */
async function listedVersions(read: ReadPath, path: string): Promise<string[]> {
  const raw = await readJson(read, path);
  const rows = (raw as { versions?: unknown } | undefined)?.versions;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (row as { version?: unknown }).version)
    .filter((version): version is string => typeof version === "string")
    .flatMap((version) => {
      const parsed = parseVersion(version);
      return parsed === undefined ? [] : [parsed];
    })
    .sort(compareVersion)
    .map(formatVersion);
}

/** The digest the root already pins for this version, if the directory is there. */
async function existingDigest(read: ReadPath, at: string): Promise<string | undefined> {
  const raw = await readJson(read, `${at}/${ENVELOPE}`);
  if (typeof raw !== "object" || raw === null) return undefined;
  const metadata = (raw as { metadata?: { digest?: unknown } }).metadata;
  return typeof metadata?.digest === "string" ? metadata.digest : undefined;
}

/** One writer per registry folder, so two publishes never take the same next version. */
export function writeOffer(
  root: string,
  changes: readonly PublishInput[],
  publishedAt: string,
  exclusive: SourceContext["exclusive"],
): Promise<WrittenOffer> {
  return exclusive(join(root, REGISTRY_DOCUMENT), () => writeOfferNow(root, changes, publishedAt));
}

async function writeOfferNow(
  root: string,
  changes: readonly PublishInput[],
  publishedAt: string,
): Promise<WrittenOffer> {
  const read = rootReader(root);
  const latest = new Map<string, OfferedVersion>();
  let unchanged = true;

  // Every change is checked before any is written: a refusal partway through
  // would leave an earlier artifact's versions.json ahead of the index.
  for (const change of changes) {
    destination(change);
    sealed(change, descriptorsOf(change));
  }

  for (const requested of changes) {
    let change = requested;
    let { namespace, version, at } = destination(change);

    const descriptors = descriptorsOf(change);
    let { envelope, digest } = sealed(change, descriptors);
    const existing = await existingDigest(read, at);
    if (existing !== digest) unchanged = false;
    // A released version is never rewritten: different bytes become the next version.
    if (existing !== undefined && existing !== digest) {
      const listed = await listedVersions(read, versionsPath(namespace, change.kind, change.name));
      change = { ...change, version: bumpVersion(listed.at(-1) ?? version) };
      ({ namespace, version, at } = destination(change));
      ({ envelope, digest } = sealed(change, descriptors));
    }
    await rm(under(root, at), { recursive: true, force: true });
    for (const file of change.files) {
      await writeAtomic(under(root, `${at}/${file.path}`), file.content);
    }
    await writeAtomic(under(root, `${at}/${ENVELOPE}`), specJson(envelope));

    const entry: OfferedVersion = {
      namespace,
      kind: change.kind,
      name: change.name,
      version,
      digest,
      ...(change.description === undefined ? {} : { description: change.description }),
    };

    const versionsAt = versionsPath(namespace, change.kind, change.name);
    const versions = mergedVersions(await readJson(read, versionsAt), entry, publishedAt);
    await writeAtomic(under(root, versionsAt), specJson(versions));
    if (versions.latest === version) latest.set(versionsAt, entry);
  }

  // Last, and once: every offered row lands in one rewrite of the catalog.
  const index = mergedIndex(
    await readJson(read, INDEX_DOCUMENT),
    [...latest.values()],
    publishedAt,
  );
  await writeAtomic(under(root, INDEX_DOCUMENT), specJson(index));

  return { unchanged };
}
