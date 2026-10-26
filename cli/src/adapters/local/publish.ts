import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  buildEnvelope,
  describeFile,
  ENVELOPE,
  type Envelope,
  type FileDescriptor,
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
  type PublishRefusal,
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
import { fail, translated } from "./errors.ts";

export interface WrittenOffer {
  /** Every version offered already sat in the root with this exact digest. */
  unchanged: boolean;
  /** Only when asked for `partial`: the changes not written, by position. */
  refused: PublishRefusal[];
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
    // The envelope is where the file spec keeps a version's edges, so its digest covers them.
    ...(change.relationships === undefined ? {} : { relationships: [...change.relationships] }),
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

/** The digest the root already pins for this version, if the directory is there. */
async function existingDigest(read: ReadPath, at: string): Promise<string | undefined> {
  const raw = await readJson(read, `${at}/${ENVELOPE}`);
  if (typeof raw !== "object" || raw === null) return undefined;
  const metadata = (raw as { metadata?: { digest?: unknown } }).metadata;
  return typeof metadata?.digest === "string" ? metadata.digest : undefined;
}

async function listedDigest(
  read: ReadPath,
  change: PublishInput,
  namespace: string,
  version: string,
): Promise<string | undefined> {
  const raw = await readJson(read, versionsPath(namespace, change.kind, change.name));
  const rows = (raw as { versions?: unknown } | undefined)?.versions;
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((each) => (each as { version?: unknown })?.version === version) as
    | { digest?: unknown }
    | undefined;
  return typeof row?.digest === "string" ? row.digest : undefined;
}

async function checkChange(read: ReadPath, change: PublishInput) {
  const { namespace, version, at } = destination(change);
  const { envelope, digest } = sealed(change, descriptorsOf(change));
  const existing =
    (await existingDigest(read, at)) ?? (await listedDigest(read, change, namespace, version));
  // A released version is never rewritten, nor quietly offered as another: the caller
  // reports the version it asked for, so different bytes there are refused.
  if (existing !== undefined && existing !== digest) {
    throw fail(
      "conflict",
      `${namespace}/${change.kind}/${change.name}@${version} is already published with other content.`,
      change.name,
      "A published version is never rewritten; publish this one as a new version.",
    );
  }
  return { change, namespace, version, at, envelope, digest, unchanged: existing === digest };
}

/**
 * One writer per registry folder, so two publishes never write one version at once.
 * With `partial`, a refused change is returned by position and the rest are written.
 */
export function writeOffer(
  root: string,
  changes: readonly PublishInput[],
  publishedAt: string,
  exclusive: SourceContext["exclusive"],
  partial = false,
): Promise<WrittenOffer> {
  return exclusive(join(root, REGISTRY_DOCUMENT), () =>
    writeOfferNow(root, changes, publishedAt, partial),
  );
}

async function writeOfferNow(
  root: string,
  changes: readonly PublishInput[],
  publishedAt: string,
  partial: boolean,
): Promise<WrittenOffer> {
  const read = rootReader(root);
  const latest = new Map<string, OfferedVersion>();

  // Every change is checked before any is written: a refusal partway through
  // would leave an earlier artifact's versions.json ahead of the index.
  const checked = [];
  const refused: PublishRefusal[] = [];
  for (const [index, change] of changes.entries()) {
    try {
      checked.push(await checkChange(read, change));
    } catch (error) {
      if (!partial) throw error;
      refused.push({ index, error: translated(error) });
    }
  }
  // Nothing left to write, so the catalog is not rewritten either.
  if (checked.length === 0 && refused.length > 0) return { unchanged: false, refused };

  for (const { change, namespace, version, at, envelope, digest } of checked) {
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

  return { unchanged: checked.every((each) => each.unchanged), refused };
}
