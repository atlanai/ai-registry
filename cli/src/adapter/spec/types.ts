type Digest = string;

type Status = "draft" | "pending_review" | "active" | "blocked" | "deprecated" | "archived";

/** The highest `format_version` this client reads. A greater one is refused, not guessed at. */
export const SUPPORTED_FORMAT = 1;

export const ENVELOPE_API_VERSION = "aireg.sh/v1";

/**
 * Bytes named by digest and size. A descriptor with a relative `urls` entry sits
 * beside the envelope; one without resolves through the registry's `blob_url`.
 */
export interface FileDescriptor {
  path: string;
  digest: Digest;
  size: number;
  media_type?: string;
  urls?: string[];
}

/** A link from one artifact to another, such as a plugin to a skill it carries. */
export interface Relationship {
  /** What the link means. */
  rel_type: string;
  /** The artifact it points at. */
  to: string;
}

/** Who an artifact is and what it says about itself. */
export interface EnvelopeMetadata {
  /** The artifact's name. */
  name: string;
  /**
   * The namespace, where the source has one. A working tree or a bare clone is
   * not a registry and has no namespace, so it reports none.
   */
  namespace?: string;
  /** Absent where the source publishes no versions: the content digest is then the identity. */
  version?: string;
  display_name?: string;
  description?: string;
  /** Status at publish. Informative: the versions document is authoritative. */
  status?: Status;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  source?: { type: "git" | "upload" | "remote" | "generated"; uri?: string; revision?: string };
  created_at?: string;
  created_by?: string;
  digest?: Digest;
  /** A registry server MAY mint one. Never required, and never an address. */
  uid?: string;
}

/** An artifact's `artifact.json`: its metadata and the files it is made of. Its digest is its content identity. */
export interface Envelope {
  /** The format's version, `aireg.sh/v1`. */
  apiVersion: string;
  /** The artifact's kind. */
  kind: string;
  /** Who it is. */
  metadata: EnvelopeMetadata;
  /** Every file, by digest and size. */
  files: FileDescriptor[];
  /** The kind's own document, unchanged. Opaque to a reader. */
  spec?: Record<string, unknown>;
  relationships?: Relationship[];
}

/**
 * An RFC 9457 problem document. `code` is what a client branches on; a server's
 * own code passes through.
 */
export interface Problem {
  type?: string;
  /** Required on the client; minted from status or code when the server omitted it. */
  title: string;
  status?: number;
  code: string;
  detail?: string;
  instance?: string;
  errors?: { path?: string; message: string }[];
  /** The id the server logged this failure under, for its operators to look up. */
  trace_id?: string;
}
