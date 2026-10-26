import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { credentialFor } from "#accounts/credentials.ts";
import { isArtifactName, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import {
  AdapterError,
  type Artifact,
  isAdapterError,
  type PublishInput,
  type PublishRelationship,
  type Relationship,
  type SourceAdapter,
  type Want,
} from "#adapter/index.ts";
import { type Bump, bumpVersion, compareVersion, parseVersion } from "#adapter/semver.ts";
import { canonicalize } from "#adapter/spec/canonical.ts";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import { ID as LOCAL } from "#adapters/local/api.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor, declaredLayout } from "#core/adapter/registry.ts";
import { type ConnectedSource, connectSource, resolveArtifacts } from "#core/adapter/source.ts";
import { readOnlyLayout } from "#core/adapter/writable.ts";
import {
  countPast,
  type Newest,
  statusClause,
  type Withheld,
  withheldFrom,
} from "#core/catalog/withheld.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { kindsOf } from "#core/filespec/write/kinds.ts";
import { type OfferTarget, offerFrom } from "#core/filespec/write/offer.ts";
import { versionProblems } from "#core/filespec/write/validate.ts";
import { posixRelative } from "#core/fs/path.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { parseRef, type Ref, RefParseError } from "#core/ref.ts";
import { readOnly } from "#engine/remote.ts";
import { type Changes, changesFrom, type Side, type StoredFile } from "./changes.ts";
import type { Work } from "./work.ts";

/** Where `--to` sends work: a registry and namespace, or one artifact at a version. */
export interface Destination {
  registry: string;
  namespace: string;
  name: string | undefined;
  version: string | undefined;
}

/** Renamed silently, it would no longer match the name in its own front matter. */
function refuseName(name: string | undefined): void {
  if (name === undefined || isArtifactName(name)) return;
  throw new AiregError(`${quoted(name)} is not a valid artifact name.`, {
    code: ErrorCode.Usage,
    hint: `Use lowercase letters, digits and hyphens, such as ${sanitizeName(name)}.`,
  });
}

export function parseTo(to: string): Destination {
  const ref = parseRef(to);
  if (ref.namespace === undefined) {
    throw new AiregError(`--to ${quoted(to)} names no namespace.`, {
      code: ErrorCode.Usage,
      hint: "Write it as <registry>/<namespace>, such as acme/engineering.",
    });
  }
  refuseName(ref.name);
  return {
    registry: ref.registry,
    namespace: ref.namespace,
    name: ref.name,
    version: ref.version,
  };
}

/** Another way to publish, in the words of an adapter that does not, as a lowercase clause. */
export function publishInstead(
  adapter: SourceAdapter,
  how = "aireg publish --to <folder>/<namespace>",
): string | undefined {
  return adapter.readOnly?.instead.replace("{how}", how);
}

/** A publish refused because the registry's adapter does not publish. */
export function cannotPublish(adapter: SourceAdapter, alias: string, how?: string): AiregError {
  const instead = publishInstead(adapter, how);
  if (adapter.readOnly === undefined || instead === undefined) {
    return readOnly(alias, adapter.displayName);
  }
  return new AiregError(adapter.readOnly.message.replace("{registry}", alias), {
    code: ErrorCode.Usage,
    hint: `${instead.charAt(0).toUpperCase()}${instead.slice(1)}.`,
  });
}

/**
 * The declared registries a publish can write to. When there are none, it refuses before
 * anything is asked, rather than after the work and a registry are picked.
 */
export async function writableRegistries(
  known: Readonly<Record<string, RegistrySource>>,
  cwd: string,
): Promise<Record<string, RegistrySource>> {
  const writable: Record<string, RegistrySource> = {};
  const refused: { alias: string; adapter: SourceAdapter }[] = [];
  const layouts: AiregError[] = [];
  for (const alias of Object.keys(known).sort()) {
    const declared = known[alias] as RegistrySource;
    // An adapter that fails to load is reported when the publish opens it.
    const adapter = await adapterFor(
      expandLocation(declared.location, cwd),
      declared.adapter,
      declaredLayout(declared.config),
    ).catch(() => undefined);
    const laidOut = readOnlyLayout(alias, declared.config);
    if (laidOut !== undefined) layouts.push(laidOut);
    else if (adapter === undefined || adapter.capabilities.publish) writable[alias] = declared;
    else refused.push({ alias, adapter });
  }
  const [first] = refused;
  if (Object.keys(writable).length > 0) return writable;
  // Only sources aireg reads by their layout: the first one's refusal says what to do.
  if (first === undefined) {
    if (layouts[0] !== undefined) throw layouts[0];
    return writable;
  }
  if (refused.length === 1) throw cannotPublish(first.adapter, first.alias);
  const instead =
    publishInstead(first.adapter) ?? "publish with `aireg publish --to <folder>/<namespace>`";
  const aliases = list(
    refused.map((each) => each.alias),
    "or",
  );
  throw new AiregError(`None of ${aliases} takes a publish.`, {
    code: ErrorCode.Usage,
    hint: `${instead.charAt(0).toUpperCase()}${instead.slice(1)}.`,
  });
}

const noNamespace = (to: string) =>
  new AiregError(`--to ${quoted(to)} names no namespace.`, {
    code: ErrorCode.Usage,
    hint: "Write it as <folder>/<namespace>, such as ../acme-registry/engineering.",
  });

const holdsRegistry = (folder: string) =>
  access(join(folder, REGISTRY_DOCUMENT)).then(
    () => true,
    () => false,
  );

/**
 * `--to ../acme-registry/engineering`: the nearest folder holding `registry.json`
 * is the registry, such as a clone of a git one, and the rest names the namespace.
 */
export async function folderTo(
  to: string,
  cwd: string,
): Promise<{ declared: RegistrySource; destination: Destination }> {
  const path = expandLocation(to, cwd);
  let root = path;
  while (!(await holdsRegistry(root))) {
    if (dirname(root) === root) {
      throw new AiregError(`${to} is not inside a registry folder.`, {
        code: ErrorCode.Usage,
        hint: "Check the path, or run `aireg registry init` to create a registry.",
      });
    }
    root = dirname(root);
  }
  const rest = posixRelative(root, path);
  if (rest === "") throw noNamespace(to);
  // As typed, less the namespace: relative to here, a symlink in either path would read differently.
  let shown = normalize(to);
  for (const _ of rest.split("/")) shown = dirname(shown);
  const registry = /^[./~]/.test(shown) || isAbsolute(shown) ? shown : `./${shown}`;
  let ref: Ref;
  try {
    ref = parseRef(`${LOCAL}/${rest}`);
  } catch (error) {
    if (!(error instanceof RefParseError)) throw error;
    throw noNamespace(to);
  }
  if (ref.namespace === undefined) throw noNamespace(to);
  refuseName(ref.name);
  return {
    declared: { location: root, adapter: LOCAL, config: {} },
    destination: { registry, namespace: ref.namespace, name: ref.name, version: ref.version },
  };
}

/** What a registry holds of one artifact now: its latest version, its files and its edges. */
interface Current {
  id: string | undefined;
  version: string | undefined;
  digests: string[];
  /** Each file by the path it is stored at; absent when the registry gives none, as for one held back. */
  files?: readonly StoredFile[] | undefined;
  relationships?: readonly Relationship[] | undefined;
  /** Published, but held back by its status, such as blocked: the registry gives no files for it. */
  withheld?: Withheld | undefined;
}

/** What one registry publishes now, read once and kept open to publish into. */
export interface Published {
  alias: string;
  location: string;
  source: ConnectedSource;
  latest: Map<string, Current>;
  /** Artifacts whose newest version the registry holds back, such as a blocked one, at that version. */
  withheld: Map<string, Current>;
  /** Each artifact's newest version where the listing shows another, such as a yanked one above it. */
  newest?: readonly Newest[] | undefined;
}

const keyOf = (namespace: string, kind: string, name: string) => `${namespace}/${kind}/${name}`;

function heldOf(artifact: Artifact, version: string | undefined): Current {
  const { files, relationships } = artifact.envelope;
  return {
    id: artifact.id,
    version,
    digests: files.map((file) => file.digest).sort(),
    files: files.map(({ path, digest }) => ({ path, digest })),
    relationships,
  };
}

async function connectToPublish(
  alias: string,
  declared: RegistrySource,
  /** Every registry this scope declares, any of which may read the same token. */
  aliases: readonly string[],
  cwd: string,
  how: string | undefined,
): Promise<{ location: string; source: ConnectedSource }> {
  const refused = readOnlyLayout(alias, declared.config);
  if (refused !== undefined) throw refused;
  const location = expandLocation(declared.location, cwd);
  const credential = await credentialFor(alias, declared, location, aliases);
  const source = await connectSource(
    {
      alias,
      location,
      declared: declared.location,
      adapter: declared.adapter,
      config: declared.config,
      layout: declaredLayout(declared.config),
    },
    credential === undefined ? {} : { credential },
  );
  if (source.handle.publish === undefined) {
    await source.handle.close();
    throw cannotPublish(source.adapter, alias, how);
  }
  return { location, source };
}

/** The namespaces a registry lists, to choose one from: the one whole listing a publish reads. */
export async function namespacesIn(
  alias: string,
  declared: RegistrySource,
  aliases: readonly string[],
  cwd: string,
  how?: string,
): Promise<string[]> {
  const { source } = await connectToPublish(alias, declared, aliases, cwd, how);
  try {
    const { listed } = await resolveArtifacts(source, [], { all: true });
    const namespaces = listed.flatMap(({ artifact }) => artifact.envelope.metadata.namespace ?? []);
    return [...new Set(namespaces)].sort();
  } finally {
    await source.handle.close();
  }
}

export async function readPublished(
  alias: string,
  declared: RegistrySource,
  aliases: readonly string[],
  cwd: string,
  /** Every artifact this run may publish or name here, as `publishWants` gives them. */
  want: readonly Want[],
  /** The command that publishes this work into a clone, for when the registry is a git one. */
  how?: string,
): Promise<Published> {
  const { location, source } = await connectToPublish(alias, declared, aliases, cwd, how);

  const listing = await resolveArtifacts(source, want);
  const latest = new Map<string, Current>();
  const newest = [...(listing.catalog.newest ?? [])];
  for (const { artifact } of listing.listed) {
    const { namespace, name, version } = artifact.envelope.metadata;
    if (namespace === undefined) continue;
    // Named, an archived version is served, though a listing of everything leaves it out: a
    // publish goes past it, so sending the same files again still revives the artifact.
    if (artifact.status?.name === "archived" && version !== undefined) {
      newest.push({ name, group: namespace, kind: artifact.kind, version });
      continue;
    }
    latest.set(keyOf(namespace, artifact.kind, name), heldOf(artifact, version));
  }

  const withheld = new Map<string, Current>();
  for (const item of listing.catalog.withheld ?? []) {
    if (item.group === undefined) continue;
    withheld.set(keyOf(item.group, item.kind, item.name), {
      id: undefined,
      version: item.version,
      digests: [],
      withheld: item,
    });
  }
  return {
    alias,
    location,
    source,
    latest,
    withheld,
    ...(newest.length === 0 ? {} : { newest }),
  };
}

/** One artifact's outcome: a first version, the next one, or already there. */
export interface Planned {
  work: Work;
  namespace: string;
  from: string | undefined;
  version: string;
  same: boolean;
  /** The version sorts below the registry's newest, as an export's own older `version` can. */
  belowLatest: boolean;
  input: PublishInput;
  /** Changes against the latest version, when files are available and a publish is needed. */
  changes?: Changes | undefined;
}

async function heldAt(
  published: Published,
  namespace: string,
  work: Work,
  version: string,
): Promise<Current | undefined> {
  const { name, kind } = work;
  const found = await published.source.handle
    .resolve([{ name, namespace, kind, version }])
    .catch(() => undefined);
  const artifact = found?.artifacts.find(
    (each) => each.envelope.metadata.version === version && each.kind === kind,
  );
  if (artifact !== undefined) return heldOf(artifact, version);

  const kept = withheldFrom(found?.withheld).find(
    (item) =>
      item.name === name &&
      item.kind === kind &&
      item.version === version &&
      (item.group === undefined || item.group === namespace),
  );
  return kept === undefined ? undefined : { id: undefined, version, digests: [], withheld: kept };
}

/**
 * Refused before anything is sent. Only a registry folder lays an agent out as the
 * spec's agent kind does; another source takes it as one `<name>.md`.
 */
async function refuseInvalid(
  work: Work,
  namespace: string,
  input: PublishInput,
  folder: boolean,
): Promise<void> {
  if (work.kind !== "skill" && !(work.kind === "agent" && folder)) return;
  const manifest = (await kindsOf(undefined))[work.kind];
  if (manifest === undefined) return;
  const decoder = new TextDecoder();
  // Only a Markdown or JSON file can hold the spec, so a binary is never decoded.
  const texts = input.files.filter((file) => /\.(md|json)$/.test(file.path));
  const problems = versionProblems(
    manifest,
    work,
    new Set(input.files.map((file) => file.path)),
    new Map(texts.map((file) => [file.path, decoder.decode(file.content)])),
  );
  if (problems.length === 0) return;
  throw new AiregError(
    `${namespace}/${work.kind}/${work.name} would not pass \`aireg registry validate\`: ${problems.join("; ")}.`,
    { code: ErrorCode.Invalid, hint: `Fix it in ${work.path}, then publish again.` },
  );
}

function refuseRelationships(
  work: Work,
  published: Published,
  relationships: readonly PublishRelationship[] | undefined,
): void {
  if (relationships === undefined || relationships.length === 0) return;
  if (published.source.adapter.capabilities.relationships === true) return;
  throw new AiregError(
    `${work.name} has dependencies, but ${published.alias} does not store them with a published version.`,
    {
      code: ErrorCode.Usage,
      hint: "Publish it to a registry folder, which does: `aireg publish <path> --to <folder>/<namespace>`.",
    },
  );
}

function refuseAgentFolder(work: Work, published: Published, input: PublishInput): void {
  if (work.kind !== "agent" || input.files.length <= 1) return;
  if (published.source.adapter.capabilities.agentFolders === true) return;
  throw new AiregError(
    `${work.name} has files beyond its AGENT.md, but ${published.alias} keeps only an agent's AGENT.md.`,
    {
      code: ErrorCode.Usage,
      hint: "Publish it to a registry folder, which keeps them: `aireg publish <path> --to <folder>/<namespace>`.",
    },
  );
}

function refuseBehind(work: Work, current: Current | undefined): void {
  if (work.base === undefined || current?.version === undefined || work.base === current.version)
    return;
  throw new AiregError(
    `${work.name} was edited from ${work.base}, but ${current.version} was published since, so publishing would drop the changes in ${current.version}.`,
    {
      code: ErrorCode.Changed,
      hint: `Install ${current.version} first and redo the edit there, or pass \`--force\` to publish over it.`,
    },
  );
}

function alreadyPublished(
  work: Work,
  namespace: string,
  held: Current,
  fixed: string | undefined,
): AiregError {
  const status = held.withheld === undefined ? "" : `, and ${statusClause(held.withheld)}`;
  return new AiregError(
    `${namespace}/${work.name}@${held.version} is already published${status}.`,
    {
      code: ErrorCode.Conflict,
      hint:
        fixed === undefined
          ? "Choose a new version, or leave the version off; a published version is never rewritten."
          : `Change the \`version\` of export ${quoted(work.exported?.path ?? work.name)}, or remove it to take the next one; a published version is never rewritten.`,
    },
  );
}

/** Explain an immutable-version conflict, including versions hidden from the listing. */
export function heldUnlisted(error: unknown, alias: string, items: readonly Planned[]): unknown {
  if (!isAdapterError(error) || error.failure !== "conflict") return error;
  const [only] = items;
  const item =
    items.find((each) => each.input.name === error.artifact) ??
    (items.length === 1 ? only : undefined);
  if (item === undefined) return error;
  const { work, namespace } = item;
  const hint =
    work.exported?.version === undefined
      ? `Name a version ${alias} does not hold yet: \`aireg publish <path> --to ${alias}/${namespace}/${work.name}@<version>\`; a published version is never rewritten.`
      : `Set the \`version\` of export ${quoted(work.exported.path)} to one ${alias} does not hold yet; a published version is never rewritten.`;
  return new AdapterError(error.adapter, error.failure, error.message, {
    artifact: error.artifact,
    retryAfterMs: error.retryAfterMs,
    problem: error.problem,
    hint,
    cause: error,
  });
}

function sameFiles(held: Current, offered: Awaited<ReturnType<typeof offerFrom>>): boolean {
  const sameDigests = held.digests.join() === offered.digests.join();
  if (held.files === undefined) return sameDigests;
  // A target may name an agent's sole entry <name>.md while a registry calls it AGENT.md.
  if (offered.input.kind === "agent" && held.files.length === 1 && offered.files.length === 1) {
    return sameDigests;
  }
  const records = (files: readonly StoredFile[]) =>
    files.map(({ path, digest }) => canonicalize({ path, digest })).sort();
  return canonicalize(records(held.files)) === canonicalize(records(offered.files));
}

function sameEdges(
  current: readonly Relationship[] | undefined,
  offered: readonly PublishRelationship[] | undefined,
): boolean {
  return canonicalize(current ?? []) === canonicalize(offered ?? []);
}

export async function plan(
  work: Work,
  published: Published,
  namespace: string,
  how: Bump,
  exact: string | undefined,
  force: boolean,
  /** Absent leaves existing edges unmanaged; an explicit list participates in version identity. */
  relationships?: readonly PublishRelationship[],
): Promise<Planned> {
  refuseRelationships(work, published, relationships);
  const key = keyOf(namespace, work.kind, work.name);
  const current = published.latest.get(key) ?? published.withheld.get(key);
  const folder = published.source.adapter.capabilities.fileSpec === true;
  if (!force) refuseBehind(work, current);
  const target = (version: string): OfferTarget => ({
    name: work.name,
    kind: work.kind,
    namespace,
    version,
    id: current?.id,
    description: work.description,
    asAgentDocument: folder,
    relationships,
    files: work.exported?.files,
  });

  const fixed = exact === undefined ? work.exported?.version : undefined;
  const asked = exact ?? fixed;

  const probe = await offerFrom(work.path, target(asked ?? "0.1.0"));
  refuseAgentFolder(work, published, probe.input);
  const matches = (held: Current) =>
    held.withheld === undefined &&
    sameFiles(held, probe) &&
    (relationships === undefined || sameEdges(held.relationships, probe.input.relationships));

  const held =
    asked === undefined
      ? undefined
      : asked === current?.version && current.withheld === undefined
        ? current
        : await heldAt(published, namespace, work, asked);

  const same =
    held !== undefined
      ? fixed !== undefined && matches(held)
      : asked === undefined && current !== undefined && matches(current);
  if (held !== undefined && !same) throw alreadyPublished(work, namespace, held, fixed);
  if (!same) await refuseInvalid(work, namespace, probe.input, folder);
  // Without SemVer there is no "next" to work out, and 0.1.0 would sort below it.
  if (
    !same &&
    asked === undefined &&
    current?.version !== undefined &&
    parseVersion(current.version) === undefined
  ) {
    throw new AiregError(
      `The current version of ${work.name}, ${current.version}, is not a SemVer version, so aireg cannot choose the next one.`,
      {
        code: ErrorCode.Usage,
        hint: `Name the version: \`aireg publish <path> --to <registry>/${namespace}/${work.name}@<version>\`.`,
      },
    );
  }

  const from = countPast(current?.version, published.newest, {
    name: work.name,
    group: namespace,
    kind: work.kind,
  });
  const version = asked ?? (same ? (current?.version as string) : bumpVersion(from, how));
  // The version is not part of the content identity, so the files read once serve it.
  const moved = version === probe.input.version ? probe.input : { ...probe.input, version };

  const input =
    same && relationships !== undefined && held !== undefined
      ? { ...moved, relationships: [...(held.relationships ?? [])] }
      : moved;
  return {
    work,
    namespace,
    from: current?.version ?? from,
    version,
    same,
    belowLatest: below(version, current?.version),
    input,
    ...changesAgainst(
      { same, current, from },
      { files: probe.files, relationships: input.relationships },
    ),
  };
}

function changesAgainst(
  at: { same: boolean; current: Current | undefined; from: string | undefined },
  sent: Side,
): { changes?: Changes } {
  const { same, current, from } = at;
  if (same) return {};
  if (current === undefined)
    return from === undefined ? { changes: changesFrom(undefined, sent) } : {};
  const { files, relationships } = current;
  return files === undefined ? {} : { changes: changesFrom({ files, relationships }, sent) };
}

function below(version: string, latest: string | undefined): boolean {
  const left = parseVersion(version);
  const right = latest === undefined ? undefined : parseVersion(latest);
  return left !== undefined && right !== undefined && compareVersion(left, right) < 0;
}

/** The commit subject for releasing these versions: `add` for one artifact's first, else `release`. */
export function releaseSubject(
  items: readonly { name: string; version: string; first?: boolean | undefined }[],
): string {
  const named = items.map((item) => `${item.name} ${item.version}`);
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    return `${only.first === true ? "add" : "release"} ${named[0]}`;
  }
  return `release ${named.slice(0, 3).join(", ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""}`;
}

/** A word as a POSIX shell reads it back unchanged. */
function shellWord(text: string): string {
  if (/^[\w@%+=:,./-]+$/.test(text)) return text;
  if (!/["$`\\!]/.test(text)) return `"${text}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Nothing in a registry folder reaches anyone until its own checkout commits and pushes it. */
export function commitAndPush(subject: string, folder = "."): string {
  const commit = `git add . && git commit -m ${shellWord(subject)} && git push`;
  // Forward slashes, which every Windows shell also takes, so the line reads the same there.
  const at = process.platform === "win32" ? folder.replaceAll("\\", "/") : folder;
  return at === "." ? commit : `cd ${shellWord(at)} && ${commit}`;
}
