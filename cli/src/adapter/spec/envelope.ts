import { extname, posix } from "node:path";
import { isSafePath } from "../paths.ts";
import { contentDigest } from "./canonical.ts";
import { isDigest } from "./ref.ts";
import {
  ENVELOPE_API_VERSION,
  type Envelope,
  type EnvelopeMetadata,
  type FileDescriptor,
} from "./types.ts";

/** What `buildEnvelope` needs: the kind, the metadata and each file's descriptor. */
export interface EnvelopeInput {
  kind: string;
  metadata: Omit<EnvelopeMetadata, "digest">;
  files: readonly FileDescriptor[];
  spec?: Record<string, unknown> | undefined;
  relationships?: Envelope["relationships"] | undefined;
}

/**
 * Adapters build envelopes here rather than by hand, so a digest cannot differ
 * by spelling: file order, absent fields and apiVersion are fixed in one place.
 */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const files = [...input.files]
    .map(descriptor)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length === 0) throw new Error(`${input.metadata.name} describes no files.`);

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`${input.metadata.name} names ${file.path} twice.`);
    seen.add(file.path);
  }

  const envelope: Envelope = {
    apiVersion: ENVELOPE_API_VERSION,
    kind: input.kind,
    metadata: prune(input.metadata),
    files,
  };
  if (input.spec !== undefined) envelope.spec = input.spec;
  if (input.relationships !== undefined && input.relationships.length > 0) {
    envelope.relationships = input.relationships;
  }
  // Recorded after the rest, because it covers the rest.
  envelope.metadata.digest = contentDigest(envelope);
  return envelope;
}

function descriptor(file: FileDescriptor): FileDescriptor {
  if (!isSafePath(file.path) || posix.isAbsolute(file.path)) {
    throw new Error(`"${file.path}" cannot address a file inside an artifact.`);
  }
  if (!isDigest(file.digest)) {
    throw new Error(`${file.path} has digest "${file.digest}", which is not a sha256 digest.`);
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error(`${file.path} has an invalid size, ${file.size}.`);
  }
  const normalized: FileDescriptor = { path: file.path, digest: file.digest, size: file.size };
  if (file.media_type !== undefined) normalized.media_type = file.media_type;
  if (file.urls !== undefined && file.urls.length > 0) normalized.urls = [...file.urls];
  return normalized;
}

/** An absent field and a field set to undefined must hash alike. */
function prune(metadata: Omit<EnvelopeMetadata, "digest">): EnvelopeMetadata {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) kept[key] = value;
  }
  return kept as unknown as EnvelopeMetadata;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".txt": "text/plain",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/javascript",
  ".sh": "application/x-sh",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/**
 * One file as an envelope describes it when it sits beside the envelope, so every
 * writer and reader builds the same descriptor, and the same digest, from the same bytes.
 */
export function describeFile(path: string, digest: string, size: number): FileDescriptor {
  const described: FileDescriptor = { path, digest, size, urls: [path] };
  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
  if (mediaType !== undefined) described.media_type = mediaType;
  return described;
}
