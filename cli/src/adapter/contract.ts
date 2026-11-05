import type { AdapterConfigSchema } from "./config.ts";
import type { Credential } from "./credential.ts";
import type { ArtifactKind } from "./kinds.ts";
import type { LayoutId } from "./layouts/ids.ts";
import type { Envelope } from "./spec/types.ts";

/** aireg loads only an adapter that declares this contract version. */
export const ADAPTER_PROTOCOL = 1;

/** Adapter ids are path segments under `/adapters/`. */
export const ADAPTER_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Where to read one file the envelope describes. */
export interface FileRef {
  /** POSIX, relative, matching a `files[].path` in the envelope. */
  path: string;
  /** Adapter-owned, opaque to the client and not part of identity. */
  locator: string;
  /** Rides here, outside identity, since a file descriptor has no executable bit. */
  executable: boolean;
}

/** One artifact, normalized. Its envelope digest is its only content identity. */
export interface Artifact {
  /** Source-owned, stable across a rename. */
  id: string;
  /** One of the kinds the adapter declares in `artifactKinds`. */
  kind: ArtifactKind;
  /** Name, version, description and files all live here. */
  envelope: Envelope;
  /** A client view of a namespace, never a kind on the wire. */
  group?: string | undefined;
  /** As npm `engines`: the oldest aireg that can install this artifact. */
  engines?: { aireg?: string } | undefined;
  /** One per `envelope.files` entry. */
  files: readonly FileRef[];
  /** The served version where the envelope cannot say it, such as a git tag; not in the digest. */
  version?: string | undefined;
  /** The commit this was read at, where not the source's own, as for a marketplace plugin. */
  revision?: string | undefined;
  /** Withdrawn: only a pin still resolves it. */
  yanked?: { reason: string | undefined } | undefined;
  /** Installs with a warning, as `deprecated`, or only by pin, as `draft`. Absent is `active`. */
  status?: { name: string; reason: string | undefined } | undefined;
}

/** How a registry names and describes itself, from its discovery document. */
export interface RegistryIdentity {
  name: string;
  /** Its name as one path segment, where it has one. */
  slug?: string | undefined;
  description?: string | undefined;
}

export interface Resolution {
  /** Each at the version asked for, or its latest. */
  artifacts: readonly Artifact[];
  /** Present iff `capabilities.pinsSource`: one revision covering every artifact. */
  sourceRevision?: string | undefined;
  /** Lets a client name the registry without guessing from the address. */
  registry?: RegistryIdentity | undefined;
  /** Artifacts a want reached that the registry's status rules kept back, rather than unpublished. */
  withheld?: readonly Withheld[] | undefined;
  /** Under `all`, the listing was read to its end: an artifact it leaves out was deleted. */
  complete?: boolean | undefined;
  /** The newest held version where it differs from the served one, yanked included. */
  newest?: readonly Newest[] | undefined;
  /** How the source was read, one sentence each, for a person. */
  warnings?: readonly string[] | undefined;
  /** Set where the adapter reads more than one layout. */
  layout?: LayoutId | undefined;
}

/** A version not installable as asked, such as a blocked one or an unpinned draft. */
export interface Withheld {
  name: string;
  namespace?: string | undefined;
  kind: ArtifactKind;
  version: string;
  /** Such as `blocked` or `draft`. */
  status: string;
  reason?: string | undefined;
}

/** The newest version a source holds of one artifact, in any status, yanked included. */
export interface Newest {
  name: string;
  namespace?: string | undefined;
  kind: ArtifactKind;
  version: string;
}

/** One artifact a client asks for. A name alone tracks latest; a version pins it. */
export interface Want {
  name: string;
  /** An exact version, which pins it. */
  version?: string | undefined;
  /** Narrows the want, so a pin reaches only the artifact it was written on. */
  namespace?: string | undefined;
  kind?: ArtifactKind | undefined;
  /** The commit a lockfile recorded for this artifact alone, which reads it again there. */
  revision?: string | undefined;
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

export interface ResolveOptions {
  /** Everything the source lists, with `want` applying only as pins. */
  all?: boolean | undefined;
}

/** What an adapter implements beyond reading. aireg calls nothing an adapter leaves off. */
export interface Capabilities {
  /** `resolve` reports a source-level revision covering every artifact. */
  pinsSource: boolean;
  /** The handle implements `publish`, and `unpublish` when the source archives. */
  publish: boolean;
  /** The adapter implements `auth.login`. */
  auth: boolean;
  /** A publish records why it was made, so a person publishing by hand is asked. */
  messages?: boolean;
  /** `publish` writes the file spec's own layout, so an agent travels as its folder's `AGENT.md`. */
  fileSpec?: boolean;
  /** Each namespace is one plugin: at user scope, a target that loads plugins gets it as one. */
  namespacePlugins?: boolean;
  /** Stores and resolves version relationships; required before the host sends dependency edges. */
  relationships?: boolean;
  /** Stores and resolves every agent file at its published path; required for folder agents. */
  agentFolders?: boolean;
}

/** Whether an adapter has a sign-in: its `auth.login`, which `capabilities.auth` must declare. */
export function canSignIn(adapter: Pick<SourceAdapter, "auth">): boolean {
  return adapter.auth?.login !== undefined;
}

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
    relationships: capabilities?.relationships === true,
    agentFolders: capabilities?.agentFolders === true,
  };
}

/**
 * A host claim covers its subdomains; anything unmatched goes to the default
 * adapter, which is what lets `acme/kit` and `git@host:path` resolve.
 */
export interface Dispatch {
  schemes?: readonly string[];
  hosts?: readonly string[];
  /** Whether the adapter reads a folder on this machine. */
  paths?: boolean;
  /** Narrower than a scheme claim, so it wins over an adapter that takes the scheme alone. */
  sites?: SiteClaim;
}

/** A claim on URLs by scheme, leaving out hosts, with their subdomains, and path endings. */
export interface SiteClaim {
  schemes: readonly string[];
  exceptHosts?: readonly string[];
  exceptSuffixes?: readonly string[];
}

/** The registry a connection is for, as the manifest declares it. */
export interface ResolvedSource {
  /** The registry's name in the manifest, for messages. */
  registry: string;
  /** As written, after the client has expanded a relative path. */
  location: string;
  /** The adapter's own settings for this registry; aireg never reads them. */
  config: Readonly<Record<string, string>>;
  /** Stable identity of this source, independent of its name and of adapter. */
  key: string;
}

export interface SourceLimits {
  /** Per request. */
  timeoutMs: number;
  /** Further tries for a request that failed for a retryable reason. */
  retries: number;
  /** The setting a timeout message tells a person to raise. */
  timeoutSetting?: string | undefined;
}

export interface SourceContext {
  source: ResolvedSource;
  credential: Credential | undefined;
  /** Aborted when the command or job is canceled; pass it to every request. */
  signal: AbortSignal;
  /** Policy as data, for the adapter to apply to whatever client it brings. */
  limits: SourceLimits;
  /** Keeps run counters honest whatever transport the adapter uses. */
  onBytes: (count: number) => void;
  /** This adapter's own folder, kept between runs and made on first ask; deleting it costs a refetch. */
  cacheDir(): string;
  /** Waits until no other aireg process holds `key`, then runs `run`: one writer per folder, say. */
  exclusive<T>(key: string, run: () => Promise<T>): Promise<T>;
}

export interface UploadFile {
  /** POSIX, relative to the artifact's folder. */
  path: string;
  content: Uint8Array;
  executable: boolean;
}

/** A `relationships[]` entry of the file spec (section 3.4). */
export interface PublishRelationship {
  /** Such as `depends_on`. */
  rel_type: string;
  /** As `<namespace>/<kind>/<name>@<version>`. */
  to: string;
}

export interface PublishInput {
  /** The source's own address for this, when it already holds it. Absent means new. */
  id?: string | undefined;
  name: string;
  /** One of the kinds the adapter publishes. */
  kind: ArtifactKind;
  namespace?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  /** The content digest of the envelope these files and relationships make, as `sha256:<hex>`. */
  contentId: string;
  /** The kind's structured fields as the host read them from the files, for a source that stores them. */
  spec?: Record<string, unknown> | undefined;
  files: readonly UploadFile[];
  /** Sent only when the adapter declares `relationships`. */
  relationships?: readonly PublishRelationship[] | undefined;
}

/** Hints on how to offer a change; a source may ignore any of them without error. */
export interface PublishOptions {
  /** Why the change was made, where the source records that. */
  message?: string | undefined;
  /** A person is publishing by hand: leave the change for review, where the source has a way to. */
  review?: boolean | undefined;
  /** Report each refused change in `refused` and carry on, keeping the ones that landed. */
  partial?: boolean | undefined;
}

export interface PublishRefusal {
  /** The change's position in the list `publish` was given. */
  index: number;
  /** Preferably an `AdapterError`. */
  error: Error;
}

/** A change the source already holds but does not serve yet, such as one awaiting review. */
export interface PublishHold {
  /** The change's position in the list `publish` was given. */
  index: number;
  reason: string;
}

export interface PublishResult {
  /** The source already holds exactly these bytes, so nothing was written. */
  unchanged?: boolean | undefined;
  /** Where the work landed, for a person to open. */
  location?: string | undefined;
  notes?: readonly string[] | undefined;
  /** Where the change stands, when that is not simply published: `Committed on branch registry/lint`. */
  summary?: string | undefined;
  /** Only under `partial`. */
  refused?: readonly PublishRefusal[] | undefined;
  /** Only under `partial`: changes neither refused nor live yet, so not to resend. */
  held?: readonly PublishHold[] | undefined;
}

export interface UnpublishInput {
  /** The id the source gave the artifact. */
  id: string;
  kind: ArtifactKind;
}

/** Who a sign-in belongs to, for aireg to show. It never decides what aireg may do. */
export interface Identity {
  /** Such as a user name or an email address. */
  name: string;
  /** The account, organization or team it acts within. */
  account?: string | undefined;
}

export interface LoginContext {
  endpoint: string;
  config: Readonly<Record<string, string>>;
  signal: AbortSignal;
  /** The CLI owns where a token comes from; an adapter given none should stop. */
  token: string | undefined;
  /** What signing in at `oauth()`'s server returned, in place of a token. */
  oauth?: Credential | undefined;
}

/** The OAuth 2.0 server and public client a person signs in with through the browser. */
export interface OAuthClient {
  /** The endpoints come from its RFC 8414 metadata and must share its origin. */
  issuer: string;
  /** Registered for a native app, with a loopback redirect. */
  clientId: string;
  /** Absent asks for the client's default. */
  scopes?: readonly string[] | undefined;
  /** For a server that pins the loopback ports, the ones registered; absent takes any free port. */
  ports?: readonly number[] | undefined;
}

/** aireg stores the credential and hands it back on connect. */
export interface SourceAuth {
  /** Exchanges a token, or runs its own flow, for a credential; identity is absent if unknown. */
  login(
    context: LoginContext,
  ): Promise<{ credential: Credential; identity?: Identity | undefined }>;
  /** Only for a credential that expires. A token an operator issued does not. */
  refresh?(endpoint: string, credential: Credential, signal: AbortSignal): Promise<Credential>;
  /** On sign-out, or when a new sign-in replaces the credential. */
  revoke?(endpoint: string, credential: Credential, signal: AbortSignal): Promise<void>;
  /** Where `auth login` signs in through the browser when no token is given. */
  oauth?(endpoint: string, config: Readonly<Record<string, string>>): OAuthClient | undefined;
}

/** One open connection to a registry. aireg closes it when it is done. */
export interface SourceHandle {
  /**
   * Empty means everything. A version the source does not publish is an error,
   * not an empty result: resolving latest instead installs the wrong bytes.
   */
  resolve(want: readonly Want[], options?: ResolveOptions): Promise<Resolution>;
  /** aireg checks the bytes against the digest the envelope gives. */
  fetch(artifact: Artifact, file: FileRef): Promise<Uint8Array>;
  /** Where a source that is already a content store is read in place; undefined fetches instead. */
  localRoot?(artifact: Artifact): Promise<string | undefined>;
  /** A set, since a source that records changes together must see them together to promise that. */
  publish?(changes: readonly PublishInput[], options: PublishOptions): Promise<PublishResult>;
  /** Where the source archives rather than deletes. */
  unpublish?(changes: readonly UnpublishInput[]): Promise<void>;
  close(): Promise<void>;
}

/** One prerequisite this adapter needs on the machine it runs on. */
export interface Readiness {
  /** Such as `git`. */
  name: string;
  ok: boolean;
  /** What was found, or what to do about it. */
  detail: string;
}

/** Write it with `defineAdapter`. */
export interface SourceAdapter {
  /** Matches `ADAPTER_ID`. A manifest names the adapter by it. */
  readonly id: string;
  readonly displayName: string;
  readonly protocol: typeof ADAPTER_PROTOCOL;
  readonly artifactKinds: readonly ArtifactKind[];
  /** Kinds `publish` accepts, where that is narrower than `artifactKinds`. */
  readonly publishKinds?: readonly ArtifactKind[];
  readonly dispatch: Dispatch;
  readonly capabilities: Capabilities;
  /** JSON Schema subset for `source.config`. Absent means any string map. */
  readonly configSchema?: AdapterConfigSchema;
  /** Required when `capabilities.auth` is on. */
  readonly auth?: SourceAuth;
  /** How to set up credentials, for an adapter that brings its own rather than `auth.login`. */
  readonly credentialsHint?: string;
  /**
   * When a publish is refused because `capabilities.publish` is off. `{registry}` is the
   * registry's name; `instead` is a lowercase clause in which `{how}` is the command to run.
   */
  readonly readOnly?: { message: string; instead: string };
  /** What this adapter needs present before it can serve anything. */
  ready?(): Promise<readonly Readiness[]>;
  connect(context: SourceContext): Promise<SourceHandle>;
}
