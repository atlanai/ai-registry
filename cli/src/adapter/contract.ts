import type { AdapterConfigSchema } from "./config.ts";
import type { Credential } from "./credential.ts";
import type { ArtifactKind } from "./kinds.ts";
import type { Envelope } from "./spec/types.ts";

/** The contract version this package defines; aireg loads only an adapter that declares it. */
export const ADAPTER_PROTOCOL = 1;

/** Adapter ids are path segments under `/adapters/`: lowercase, no dots. */
export const ADAPTER_ID = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * How to read one file the envelope describes. The descriptor in `files[]` names
 * the bytes; this names where to get them, which is the adapter's own business.
 */
export interface FileRef {
  /** POSIX, relative, matching a `files[].path` in the envelope. */
  path: string;
  /** Adapter-owned read handle, opaque to the client and excluded from identity. */
  locator: string;
  /** No executable bit exists on a FileDescriptor, so the mode rides here, outside identity. */
  executable: boolean;
}

/** One artifact, normalized. Its envelope digest is the only content identity. */
export interface Artifact {
  /** Source-owned, stable across a rename, for as long as the artifact exists. */
  id: string;
  /** One of the kinds the adapter declares in `artifactKinds`. */
  kind: ArtifactKind;
  /** The file spec envelope. Name, version, description and files all live here. */
  envelope: Envelope;
  /**
   * The plugin this belongs to, when the source groups its artifacts. A client
   * projection of a namespace, never a kind on the wire.
   */
  group?: string | undefined;
  /** npm `engines`. Oldest aireg CLI that can install this artifact. */
  engines?: { aireg?: string } | undefined;
  /** One per `envelope.files` entry, by path. */
  files: readonly FileRef[];
  /** Set when the version was withdrawn, which only a pin still resolves. */
  yanked?: { reason: string | undefined } | undefined;
}

/** How a registry names and describes itself, from its discovery document. */
export interface RegistryIdentity {
  /** What a person calls the registry. */
  name: string;
  /** Its name as one path segment, where it has one. */
  slug?: string | undefined;
  /** One line on what it holds. */
  description?: string | undefined;
}

/** What `resolve` found. */
export interface Resolution {
  /** Every artifact that matched, each at the version asked for or its latest. */
  artifacts: readonly Artifact[];
  /** Present iff `capabilities.pinsSource`: one revision covering every artifact. */
  sourceRevision?: string | undefined;
  /** What the registry calls itself, so a client can name it without guessing from the address. */
  registry?: RegistryIdentity | undefined;
  /** Artifacts a want reached that the registry's status rules kept back, rather than unpublished. */
  withheld?: readonly Withheld[] | undefined;
}

/** An artifact whose version is not installable as asked, such as a blocked one or an unpinned draft. */
export interface Withheld {
  name: string;
  namespace?: string | undefined;
  kind: ArtifactKind;
  /** The version the request reached. */
  version: string;
  /** The version's status, such as `blocked` or `draft`. */
  status: string;
  /** Why, as the registry gives it. */
  reason?: string | undefined;
}

/** One artifact a client asks for. A name alone tracks latest; a version pins it. */
export interface Want {
  /** The artifact's name, as its envelope gives it. */
  name: string;
  /** An exact version, which pins it. */
  version?: string | undefined;
  /** Each narrows the want, so a pin reaches only the artifact it was written on. */
  namespace?: string | undefined;
  /** Narrows the want to one kind, as `namespace` narrows it to one namespace. */
  kind?: ArtifactKind | undefined;
}

/** Whether a want reaches an artifact: by name, narrowed by the namespace and kind it gives. */
export function covers(
  want: Want,
  artifact: { name: string; namespace: string | undefined; kind: ArtifactKind },
): boolean {
  return (
    want.name === artifact.name &&
    (want.namespace === undefined || want.namespace === artifact.namespace) &&
    (want.kind === undefined || want.kind === artifact.kind)
  );
}

/** How `resolve` reads its wants. */
export interface ResolveOptions {
  /** Everything the source lists, with `want` applying only as pins. */
  all?: boolean | undefined;
}

/** What an adapter implements beyond reading. aireg calls nothing an adapter leaves off. */
export interface Capabilities {
  /** `resolve` reports a source-level revision covering every artifact. */
  pinsSource: boolean;
  /** The handle implements `publish` (and `unpublish` when the source archives). */
  publish: boolean;
  /** The adapter implements `auth.login`. */
  auth: boolean;
  /** A publish records why it was made, so a person publishing by hand is asked. */
  messages?: boolean;
  /** `publish` writes the file spec's own layout, so an agent travels as its folder's `AGENT.md`. */
  fileSpec?: boolean;
  /**
   * Each namespace the source lists is one plugin: at user scope, a harness that loads plugins
   * gets the namespace as one, named after it, rather than each artifact on its own.
   */
  namespacePlugins?: boolean;
}

/** Whether an adapter has a sign-in: its `auth.login`, which `capabilities.auth` must declare. */
export function canSignIn(adapter: Pick<SourceAdapter, "auth">): boolean {
  return adapter.auth?.login !== undefined;
}

/** Missing flags are off. */
export function advertisedCapabilities(
  capabilities: Partial<Capabilities> | undefined,
): Capabilities {
  return {
    pinsSource: capabilities?.pinsSource === true,
    publish: capabilities?.publish === true,
    auth: capabilities?.auth === true,
    messages: capabilities?.messages === true,
    fileSpec: capabilities?.fileSpec === true,
    namespacePlugins: capabilities?.namespacePlugins === true,
  };
}

/**
 * A host claim covers its subdomains; anything unmatched goes to the default
 * adapter, which is what lets `acme/kit` and `git@host:path` resolve.
 */
export interface Dispatch {
  /** URL schemes the adapter reads, such as `https`. */
  schemes?: readonly string[];
  /** Hosts the adapter reads, each with its subdomains. */
  hosts?: readonly string[];
  /** Whether the adapter reads a folder on this machine. */
  paths?: boolean;
}

/** The registry a connection is for, as the manifest declares it. */
export interface ResolvedSource {
  /** The registry's name in the manifest, used in messages so a person knows which entry failed. */
  registry: string;
  /** The address as written, after the client has expanded a relative path. */
  location: string;
  /** The adapter's own settings for this registry, as declared; aireg never reads them. */
  config: Readonly<Record<string, string>>;
  /** Stable identity of this source, independent of its name and of adapter. */
  key: string;
}

/** How long and how often the adapter may try, as aireg's settings say. */
export interface SourceLimits {
  /** How long one request may take. */
  timeoutMs: number;
  /** How many times a request that failed for a retryable reason may be tried again. */
  retries: number;
  /** The setting a person changes to allow more time, for the message a timeout prints. */
  timeoutSetting?: string | undefined;
}

/** Everything a connection is given. */
export interface SourceContext {
  /** The registry to connect to. */
  source: ResolvedSource;
  /** The sign-in for this registry, when there is one. */
  credential: Credential | undefined;
  /** Aborted when the command or job is canceled; pass it to every request. */
  signal: AbortSignal;
  /** Policy as data. The adapter applies it to whatever client it brings. */
  limits: SourceLimits;
  /** Keeps run counters honest whatever transport the adapter uses. */
  onBytes: (count: number) => void;
  /** A folder of this adapter's own, kept between runs and created on first ask; deleting it costs a refetch. */
  cacheDir(): string;
  /** Runs `run` while no other aireg process holds `key`, waiting its turn, such as one writer per folder. */
  exclusive<T>(key: string, run: () => Promise<T>): Promise<T>;
}

/** One file of an artifact being published. */
export interface UploadFile {
  /** POSIX, relative to the artifact's folder. */
  path: string;
  content: Uint8Array;
  /** Whether it was executable on disk. */
  executable: boolean;
}

/** One artifact to publish. */
export interface PublishInput {
  /** The source's own address for this, when it already holds it. Absent means new. */
  id?: string | undefined;
  name: string;
  /** One of the kinds the adapter publishes. */
  kind: ArtifactKind;
  /** Whose corner of the registry this belongs in. A root addresses by it. */
  namespace?: string | undefined;
  /** The version being offered. A root stores one version directory per value. */
  version?: string | undefined;
  /** One line on what it does. */
  description?: string | undefined;
  /** The content digest of the envelope these files make, as `sha256:<hex>`. */
  contentId: string;
  /** The kind's structured fields as the host read them from the files, for a source that stores them. */
  spec?: Record<string, unknown> | undefined;
  files: readonly UploadFile[];
}

/**
 * How to offer a change, not what to change. Every field is a hint a source may
 * have no notion of, and ignoring one is never an error.
 */
export interface PublishOptions {
  /** Why the change was made, where the source records that. */
  message?: string | undefined;
  /** A person is publishing by hand: leave the change for review, where the source has a way to. */
  review?: boolean | undefined;
  /**
   * The host records each change on its own: report a refused one in
   * `refused` and carry on, rather than throwing away the ones that landed.
   */
  partial?: boolean | undefined;
}

/** One change the source would not take, by its position in the request. */
export interface PublishRefusal {
  /** The change's position in the list `publish` was given. */
  index: number;
  /** Why, preferably an `AdapterError`. */
  error: Error;
}

/** One change the source already holds but does not serve yet, such as one awaiting review. */
export interface PublishHold {
  /** The change's position in the list `publish` was given. */
  index: number;
  /** Why it is not live, for a person to read. */
  reason: string;
}

/** What a publish did. */
export interface PublishResult {
  /** The source already holds exactly these bytes, so nothing was written. */
  unchanged?: boolean | undefined;
  /** Where the work landed, for a person to open. */
  location?: string | undefined;
  /** Anything worth showing the person who asked, one line each. */
  notes?: readonly string[] | undefined;
  /** Where the change stands, when that is not simply published: `Committed on branch registry/lint`. */
  summary?: string | undefined;
  /** Only when asked for `partial`: every change not written, and why. */
  refused?: readonly PublishRefusal[] | undefined;
  /** Only when asked for `partial`: changes neither refused nor live yet, so not to resend. */
  held?: readonly PublishHold[] | undefined;
}

/** One artifact to withdraw, by the id the source gave it. */
export interface UnpublishInput {
  id: string;
  kind: ArtifactKind;
}

/** Who a sign-in belongs to, for aireg to show. It never decides what aireg may do. */
export interface Identity {
  /** The person or service the credential acts as, such as a user name or an email address. */
  name: string;
  /** The account, organization or team it acts within, where the registry has one. */
  account?: string | undefined;
}

/** What a sign-in is given. */
export interface LoginContext {
  /** The registry's address. */
  endpoint: string;
  /** Aborted when the person gives up. */
  signal: AbortSignal;
  /** The CLI owns where a token comes from; an adapter given none should stop. */
  token: string | undefined;
}

/** How an adapter signs in. aireg stores the credential and hands it back on connect. */
export interface SourceAuth {
  /**
   * Exchanges a token, or the adapter's own flow, for a credential. The identity
   * is absent when the registry does not say who the credential belongs to.
   */
  login(
    context: LoginContext,
  ): Promise<{ credential: Credential; identity?: Identity | undefined }>;
  /** Only for a credential that expires. A token an operator issued does not. */
  refresh?(endpoint: string, credential: Credential, signal: AbortSignal): Promise<Credential>;
  /** Tells the registry a credential is no longer used, on sign-out. */
  revoke?(endpoint: string, credential: Credential, signal: AbortSignal): Promise<void>;
}

/** One open connection to a registry. aireg closes it when it is done. */
export interface SourceHandle {
  /**
   * Empty means everything. A version the source does not publish is an error,
   * not an empty result: resolving latest instead installs the wrong bytes.
   */
  resolve(want: readonly Want[], options?: ResolveOptions): Promise<Resolution>;
  /** One file's bytes. aireg checks them against the digest the envelope gives. */
  fetch(artifact: Artifact, file: FileRef): Promise<Uint8Array>;
  /** A source that is already a content store says where, and is read in place; undefined fetches instead. */
  localRoot?(artifact: Artifact): Promise<string | undefined>;
  /**
   * Offers a set, not one artifact: a source that records changes together can
   * only promise that by seeing them together, and N single calls cannot.
   */
  publish?(changes: readonly PublishInput[], options: PublishOptions): Promise<PublishResult>;
  /** Withdraws artifacts the source holds, where it archives rather than deletes. */
  unpublish?(changes: readonly UnpublishInput[]): Promise<void>;
  close(): Promise<void>;
}

/** One prerequisite this adapter needs on the machine it runs on. */
export interface Readiness {
  /** What is needed, such as `git`. */
  name: string;
  /** Whether it is there. */
  ok: boolean;
  /** What was found, or what to do about it. */
  detail: string;
}

/** An adapter: how aireg reads one kind of registry. Write it with `defineAdapter`. */
export interface SourceAdapter {
  /** Matches `ADAPTER_ID`. A manifest names the adapter by it. */
  readonly id: string;
  /** What a person calls it in messages. */
  readonly displayName: string;
  /** The contract version it implements. */
  readonly protocol: typeof ADAPTER_PROTOCOL;
  /** The kinds it serves. */
  readonly artifactKinds: readonly ArtifactKind[];
  /** Kinds `publish` accepts, where that is narrower than what is served. */
  readonly publishKinds?: readonly ArtifactKind[];
  /** Which addresses aireg sends to it. */
  readonly dispatch: Dispatch;
  /** What it implements beyond reading. */
  readonly capabilities: Capabilities;
  /** JSON Schema subset for `source.config`. Absent means any string map. */
  readonly configSchema?: AdapterConfigSchema;
  /** Its sign-in, when `capabilities.auth` is on. */
  readonly auth?: SourceAuth;
  /** How to set up credentials, for an adapter that brings its own rather than `auth.login`. */
  readonly credentialsHint?: string;
  /**
   * What to say when a publish is refused because `capabilities.publish` is off. `{registry}`
   * is the registry's name; `instead` is a lowercase clause in which `{how}` is the command to run.
   */
  readonly readOnly?: { message: string; instead: string };
  /** What this adapter needs present before it can serve anything. */
  ready?(): Promise<readonly Readiness[]>;
  /** Opens a connection to one registry. */
  connect(context: SourceContext): Promise<SourceHandle>;
}
