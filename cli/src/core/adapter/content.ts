import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { CliCode } from "#adapter/codes.ts";
import { adapterProblem, failureOf } from "#adapter/errors.ts";
import { assertUnredirected, copyRegular, hashRegular } from "#adapter/files.ts";
import {
  AdapterError,
  type Artifact,
  buildEnvelope,
  contentDigest,
  type Envelope,
  type FileDescriptor,
  type FileRef,
  isAdapterError,
  type SourceHandle,
} from "#adapter/index.ts";
import { assertWithin } from "#adapter/paths.ts";
import { sha256 } from "#adapter/spec/canonical.ts";
import { plural } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { EXECUTABLE } from "#core/fs/mode.ts";
import { exists } from "#core/fs/tree.ts";
import { KIND_SPECS } from "#core/kinds.ts";
import { CONCURRENCY, limiter, weighted } from "#core/limit.ts";

const fetching = limiter(CONCURRENCY);

/**
 * A fetch arrives whole, so the files in flight are bounded by their bytes as
 * well as their number: sixteen large assets would otherwise all be held at once.
 */
const holding = weighted(128 * 1024 * 1024);

const STAGING_PREFIX = ".staging-";

type Code = Extract<CliCode, "DIGEST_MISMATCH" | "SPEC_INVALID" | "NOT_FOUND">;

type Fail = (file: FileRef, message: string, code?: Code) => AdapterError;

function describedBy(envelope: Envelope): Map<string, FileDescriptor> {
  return new Map(envelope.files.map((descriptor) => [descriptor.path, descriptor]));
}

/** File spec section 4.1: bytes that do not match what described them never land. */
function mismatch(
  found: { size: number; digest: string },
  descriptor: FileDescriptor,
): string | undefined {
  if (found.size !== descriptor.size) {
    return `arrived as ${found.size} bytes, but ${descriptor.size} were described`;
  }
  if (found.digest !== descriptor.digest) {
    return `arrived with digest ${found.digest}, but ${descriptor.digest} was described`;
  }
  return undefined;
}

function verify(bytes: Uint8Array, descriptor: FileDescriptor, file: FileRef, fail: Fail): void {
  const digest = sha256(bytes);
  const wrong = mismatch({ size: bytes.byteLength, digest }, descriptor);
  if (wrong !== undefined) throw fail(file, wrong, "DIGEST_MISMATCH");
}

/** Why something did not land, for a caller that names the artifact itself. */
export function reasonOf(error: unknown): string {
  if (isAdapterError(error)) return adapterProblem(error).title;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The member a published file belongs to: `<kind dir>/<name>`. A member missing
 * one file is broken, so it is dropped whole rather than half-installed.
 */
function memberOf(path: string): string {
  const parts = path.split(posix.sep);
  return parts.length > 2 ? parts.slice(0, 2).join(posix.sep) : path;
}

interface Written {
  kept: FileDescriptor[];
  /** Members the source would not serve. Only ever non-empty for a collection. */
  missing: string[];
  /** Why each missing member was dropped, so the caller can say so. */
  reasons: Map<string, AdapterError>;
}

async function writeFiles(
  root: string,
  artifact: Artifact,
  read: (file: FileRef) => Promise<Uint8Array>,
  fail: Fail,
  /** A collection survives a member it cannot fetch; a single artifact does not. */
  collection: boolean,
  onRead?: (bytes: number) => void,
): Promise<Written> {
  const described = describedBy(artifact.envelope);
  const landed: FileDescriptor[] = [];
  const absent = new Set<string>();
  const why = new Map<string, AdapterError>();
  let failed = false;

  const one = async (file: FileRef): Promise<void> => {
    // The directory is about to be removed, so the rest stop fetching into it.
    if (failed) return;
    try {
      const descriptor = described.get(file.path);
      if (descriptor === undefined) {
        throw fail(file, "is not in the artifact's file list", "SPEC_INVALID");
      }

      const target = join(root, ...file.path.split(posix.sep));
      assertWithin(root, target, "published file");
      const bytes = await read(file);
      onRead?.(bytes.byteLength);
      verify(bytes, descriptor, file, fail);
      landed.push(descriptor);

      await assertUnredirected(root, target);
      await mkdir(dirname(target), { recursive: true });
      await assertUnredirected(root, target);
      await writeFile(target, bytes);
      if (file.executable) await chmod(target, EXECUTABLE);
    } catch (error) {
      // Dropping one bad member is the safe half of the choice - the bytes never
      // land either way - and it is what keeps the other members installable.
      const droppable =
        isAdapterError(error) && (error.failure === "not_found" || error.failure === "invalid");
      if (collection && droppable) {
        absent.add(memberOf(file.path));
        why.set(memberOf(file.path), error);
        return;
      }
      failed = true;
      throw error;
    }
  };

  // Settled rather than raced, so nothing is still writing into the staging
  // directory when the caller starts removing it.
  const results = await Promise.allSettled(
    artifact.files.map((file) =>
      fetching(() => holding(described.get(file.path)?.size ?? 0, () => one(file))),
    ),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  if (absent.size === 0) return { kept: landed, missing: [], reasons: why };

  // Everything else the member published goes with it: half a skill reads as a
  // whole one to the target that loads it.
  const missing = [...absent].sort();
  const kept = landed.filter((descriptor) => !absent.has(memberOf(descriptor.path)));
  if (kept.length === 0) {
    const name = artifact.envelope.metadata.name;
    throw new AiregError(
      `${name}: the registry served none of its ${plural(missing.length, "member")}.`,
      { code: ErrorCode.Unavailable },
    );
  }
  await Promise.all(
    missing.map((member) =>
      rm(join(root, ...member.split(posix.sep)), { recursive: true, force: true }),
    ),
  );
  return { kept, missing, reasons: why };
}

function contentAt(artifact: Artifact, root: string): string {
  if (KIND_SPECS[artifact.kind].shape === "directory") return root;
  const only = artifact.files[0] as Artifact["files"][number];
  return join(root, ...only.path.split(posix.sep));
}

/**
 * Content already on this machine still has to be what the envelope describes,
 * so it is checked against the same descriptors rather than hashed a second way.
 */
async function verifyAt(
  root: string,
  files: readonly FileRef[],
  envelope: Envelope,
  fail: Fail,
): Promise<void> {
  const described = describedBy(envelope);
  for (const file of files) {
    const descriptor = described.get(file.path);
    if (descriptor === undefined) {
      throw fail(file, "is not in the artifact's file list", "SPEC_INVALID");
    }
    // Verified, not copied, so a large asset is hashed as it streams past.
    const read = await hashRegular(root, descriptor.path);
    if (read.kind === "missing") throw fail(file, "is missing", "NOT_FOUND");
    if (read.kind === "refused") throw fail(file, read.reason, "SPEC_INVALID");
    const wrong = mismatch(read, descriptor);
    if (wrong !== undefined) throw fail(file, wrong, "DIGEST_MISMATCH");
  }
}

/**
 * A version read where its source keeps it, copied file by file from its
 * envelope: nothing it does not describe lands, and no link is followed.
 */
export async function copyDescribed(
  from: { root: string; path: string; envelope: Envelope },
  to: string,
): Promise<void> {
  // A file-shaped kind is the one file at `path`; a directory is every file.
  const single = from.path !== from.root;
  const files = from.envelope.files.filter(
    (file) => !single || join(from.root, ...file.path.split(posix.sep)) === from.path,
  );
  for (const descriptor of files) {
    const target = single ? to : join(to, ...descriptor.path.split(posix.sep));
    assertWithin(to, target, "published file");
    await assertUnredirected(to, target);
    await mkdir(dirname(target), { recursive: true });
    await assertUnredirected(to, target);
    // Streamed beside the target and landed only once its digest checks out,
    // so a large file is never held whole and a bad one never lands.
    const part = `${target}.${randomUUID()}.part`;
    try {
      const read = await copyRegular(from.root, descriptor.path, part);
      const problem =
        read.kind === "missing"
          ? "is missing"
          : read.kind === "refused"
            ? read.reason
            : mismatch(read, descriptor);
      if (problem !== undefined) {
        throw new AiregError(`${from.envelope.metadata.name}: ${descriptor.path} ${problem}.`, {
          code: ErrorCode.Integrity,
        });
      }
      await rename(part, target);
    } finally {
      await rm(part, { force: true });
    }
  }
}

/** A subset of the files is a different artifact, so it gets its own envelope. */
function envelopeOf(envelope: Envelope, files: readonly FileDescriptor[]): Envelope {
  const { digest: _digest, ...metadata } = envelope.metadata;
  return buildEnvelope({
    kind: envelope.kind,
    metadata,
    files,
    spec: envelope.spec,
    relationships: envelope.relationships,
  });
}

/** A member of a collection that did not land, and why. */
interface Dropped {
  member: string;
  reason: string;
  error: AdapterError | undefined;
}

export interface MaterializeOptions {
  /**
   * Where bytes with this content digest are kept between runs. Keyed by what
   * they are, so a cached copy can be checked against the envelope asking for it.
   */
  into: (contentId: string) => string;
  /** Trusted cache boundary for CLI-managed staging paths. */
  boundary?: string;
  onRead?: ((bytes: number) => void) | undefined;
}

/**
 * Materialize through a sibling staging directory so the move into place is a
 * rename on the same filesystem. The path returned is the content, not the root.
 */
export async function materialize(
  adapterId: string,
  handle: SourceHandle,
  artifact: Artifact,
  options: MaterializeOptions,
): Promise<{
  path: string;
  root: string;
  contentId: string;
  /** What landed, which for a short collection is less than the artifact describes. */
  envelope: Envelope;
  dropped: Dropped[];
}> {
  const name = artifact.envelope.metadata.name;
  // The title is about the file, for a caller that already names the artifact;
  // the message names it too, for one that doesn't.
  const fail: Fail = (file, message, code = "SPEC_INVALID") => {
    const title = `${file.path} ${message}.`;
    return new AdapterError(adapterId, failureOf({ code, title }), `${name}: ${title}`, {
      artifact: name,
      problem: { code, title },
    });
  };

  // Known before anything is fetched, so the cache is always consulted first.
  const expected = contentDigest(artifact.envelope);
  const landed = (
    root: string,
    contentId: string,
    envelope: Envelope,
    dropped: Dropped[] = [],
  ) => ({
    path: contentAt(artifact, root),
    root,
    contentId,
    envelope,
    dropped,
  });

  // A source that is already a content store is read where it lies, and only
  // what its envelope describes is ever copied out of it (`copyDescribed`).
  const local = await handle.localRoot?.(artifact);
  if (local !== undefined) {
    await verifyAt(local, artifact.files, artifact.envelope, fail);
    return landed(local, expected, artifact.envelope);
  }

  const guard = async (path: string): Promise<void> => {
    if (options.boundary !== undefined) await assertUnredirected(options.boundary, path);
  };
  // Whatever sits in the cache is used only once it checks out; anything else is fetched again.
  const reusable = async (dir: string, files: readonly FileRef[], envelope: Envelope) => {
    await guard(dir);
    if (!(await exists(dir))) return false;
    try {
      await verifyAt(dir, files, envelope, fail);
      return true;
    } catch {
      await rm(dir, { recursive: true, force: true });
      return false;
    }
  };

  const whole = options.into(expected);
  if (await reusable(whole, artifact.files, artifact.envelope)) {
    return landed(whole, expected, artifact.envelope);
  }

  const parent = dirname(whole);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, STAGING_PREFIX));
  try {
    const collection = artifact.kind === "plugin";
    const { kept, missing, reasons } = await writeFiles(
      staging,
      artifact,
      (file) => handle.fetch(artifact, file),
      fail,
      collection,
      options.onRead,
    );

    // A short collection is not what the envelope describes, so it is kept under
    // the digest of what did arrive, where a run asking for the whole never looks.
    const envelope = missing.length > 0 ? envelopeOf(artifact.envelope, kept) : artifact.envelope;
    const contentId = contentDigest(envelope);
    const landing = describedBy(envelope);
    const files = artifact.files.filter((file) => landing.has(file.path));
    const dropped: Dropped[] = missing.map((member) => ({
      member,
      reason: reasonOf(reasons.get(member)),
      error: reasons.get(member),
    }));
    const final = options.into(contentId);
    if (await reusable(final, files, envelope)) return landed(final, contentId, envelope, dropped);

    await mkdir(dirname(final), { recursive: true });
    await guard(final);
    try {
      await rename(staging, final);
    } catch (error) {
      // A concurrent run finished first; its copy is identical by construction.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
    return landed(final, contentId, envelope, dropped);
  } finally {
    await guard(staging);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
