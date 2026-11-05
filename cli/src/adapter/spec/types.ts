type Digest = string;

type Status = "draft" | "pending_review" | "active" | "blocked" | "deprecated" | "archived";

/** The highest `format_version` this client reads; a greater one is refused. */
export const SUPPORTED_FORMAT = 1;

export const ENVELOPE_API_VERSION = "aireg.sh/v1";

/** A relative `urls` entry sits beside the envelope; without one, `blob_url` locates it. */
export interface FileDescriptor {
  path: string;
  digest: Digest;
  size: number;
  media_type?: string;
  urls?: string[];
}

/** A link to another artifact, such as a plugin to a skill it carries. */
export interface Relationship {
  rel_type: string;
  to: string;
}

export interface EnvelopeMetadata {
  name: string;
  /** Absent for a working tree or a bare clone. */
  namespace?: string;
  /** Absent where the source publishes no versions; the content digest is then the identity. */
  version?: string;
  display_name?: string;
  description?: string;
  /** Informative only; the versions document is authoritative. */
  status?: Status;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  source?: { type: "git" | "upload" | "remote" | "generated"; uri?: string; revision?: string };
  created_at?: string;
  created_by?: string;
  digest?: Digest;
  /** A server may mint one. Never required, and never an address. */
  uid?: string;
}

/** An artifact's `artifact.json`. Its digest is its content identity. */
export interface Envelope {
  apiVersion: string;
  kind: string;
  metadata: EnvelopeMetadata;
  files: FileDescriptor[];
  /** The kind's own document, opaque to a reader. */
  spec?: Record<string, unknown>;
  relationships?: Relationship[];
}

/** An RFC 9457 problem document. Clients branch on `code`; a server's own code passes through. */
export interface Problem {
  type?: string;
  /** Minted from status or code when the server omits it. */
  title: string;
  status?: number;
  code: string;
  detail?: string;
  instance?: string;
  errors?: { path?: string; message: string }[];
  trace_id?: string;
}
