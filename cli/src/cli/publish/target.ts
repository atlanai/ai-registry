import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { credentialFor } from "#accounts/credentials.ts";
import { isArtifactName, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import type {
  Artifact,
  PublishInput,
  PublishRelationship,
  Relationship,
  SourceAdapter,
} from "#adapter/index.ts";
import {
  type Bump,
  bumpVersion,
  compareVersion,
  parseVersion,
  satisfies,
} from "#adapter/semver.ts";
import { canonicalize } from "#adapter/spec/canonical.ts";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import { ID as LOCAL } from "#adapters/local/api.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor } from "#core/adapter/registry.ts";
import { type ConnectedSource, connectSource, resolveArtifacts } from "#core/adapter/source.ts";
import { readOnlyLayout } from "#core/adapter/writable.ts";
import { statusClause, type Withheld, withheldFrom } from "#core/catalog/withheld.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { kindsOf } from "#core/filespec/write/kinds.ts";
import { type OfferTarget, offerFrom } from "#core/filespec/write/offer.ts";
import { versionProblems } from "#core/filespec/write/validate.ts";
import { posixRelative } from "#core/fs/path.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { parseRef, type Ref, RefParseError } from "#core/ref.ts";
import { readOnly } from "#engine/remote.ts";
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

/** A publish makes one version, so a range has nothing to say about which. */
function refuseRange(to: string, ref: Ref): void {
  if (ref.range === undefined) return;
  throw new AiregError(`--to ${quoted(to)} names a version range, not a version.`, {
    code: ErrorCode.Usage,
    hint: "Name one version, such as @1.2.0, or leave it off to take the next one.",
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
  refuseRange(to, ref);
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
  refuseRange(to, ref);
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
  relationships?: readonly Relationship[] | undefined;
  /** Published, but held back by its status, such as blocked: the registry gives no files for it. */
  withheld?: Withheld | undefined;
}

/** What one registry publishes now, read once and kept open to publish into. */
export interface Published {
  alias: string;
  location: string;
  source: ConnectedSource;
  namespaces: string[];
  latest: Map<string, Current>;
  /** Artifacts whose newest version the registry holds back, such as a blocked one, at that version. */
  withheld: Map<string, Current>;
}

const keyOf = (namespace: string, kind: string, name: string) => `${namespace}/${kind}/${name}`;

function digestsOf(artifact: Artifact): string[] {
  return artifact.envelope.files.map((file) => file.digest).sort();
}

export async function readPublished(
  alias: string,
  declared: RegistrySource,
  cwd: string,
  /** The command that publishes this work into a clone, for when the registry is a git one. */
  how?: string,
): Promise<Published> {
  const refused = readOnlyLayout(alias, declared.config);
  if (refused !== undefined) throw refused;
  const location = expandLocation(declared.location, cwd);
  const credential = await credentialFor(alias, declared, location);
  const source = await connectSource(
    {
      alias,
      location,
      declared: declared.location,
      adapter: declared.adapter,
      config: declared.config,
    },
    credential === undefined ? {} : { credential },
  );
  if (source.handle.publish === undefined) {
    await source.handle.close();
    throw cannotPublish(source.adapter, alias, how);
  }
  const listing = await resolveArtifacts(source, [], { all: true });
  const latest = new Map<string, Current>();
  const namespaces = new Set<string>();
  for (const { artifact } of listing.listed) {
    const { namespace, name, version } = artifact.envelope.metadata;
    if (namespace === undefined) continue;
    namespaces.add(namespace);
    latest.set(keyOf(namespace, artifact.kind, name), {
      id: artifact.id,
      version,
      digests: digestsOf(artifact),
      relationships: artifact.envelope.relationships,
    });
  }
  // Held back is still published: the next version goes past it, never back over it.
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
  return { alias, location, source, namespaces: [...namespaces].sort(), latest, withheld };
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
}

/** What the registry holds at one version of this artifact, when it holds that version. */
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
  if (artifact !== undefined) {
    return {
      id: artifact.id,
      version,
      digests: digestsOf(artifact),
      relationships: artifact.envelope.relationships,
    };
  }
  // A resolve hides a version its status holds back, such as a blocked one, but still names it.
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

/**
 * An adapter without `capabilities.relationships` would publish the files alone, and the
 * artifact would install without what it depends on, so nothing is sent to it at all.
 */
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

/**
 * An edit made on an older version, published as the newest, drops whatever
 * was published in between; that is a conflict, the same one sync reports.
 */
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

/** A version asked for that the registry holds with other content, or holds back unseen. */
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

/** The same edges, whatever order each one's fields were written in. */
function sameEdges(
  current: readonly Relationship[] | undefined,
  offered: readonly PublishRelationship[] | undefined,
): boolean {
  return canonicalize(current ?? []) === canonicalize(offered ?? []);
}

/** `eng/skill/review@0.1.1` as the artifact it names, and the version. */
function named(to: string): { artifact: string; version: string } {
  const at = to.lastIndexOf("@");
  return { artifact: to.slice(0, at), version: to.slice(at + 1) };
}

/**
 * Whether the edges a fixed version was published with still take what this run plans: the same
 * artifacts, by the same kind of edge in the same registry, each at a version the held edge's
 * range accepts, or its exact version when it has none. A dependency's next patch release then
 * leaves its dependent as it is, rather than asking to rewrite a version that cannot change.
 */
function edgesHold(
  held: readonly Relationship[] | undefined,
  offered: readonly PublishRelationship[] | undefined,
): boolean {
  const order = (edges: readonly Relationship[]) =>
    [...edges]
      .map((edge) => ({
        edge,
        key: `${edge.rel_type} ${edge.registry ?? ""} ${named(edge.to).artifact}`,
      }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const before = order(held ?? []);
  const after = order(offered ?? []);
  return (
    before.length === after.length &&
    before.every(({ edge, key }, at) => {
      const next = after[at];
      if (next === undefined || next.key !== key) return false;
      const version = named(next.edge.to).version;
      return edge.range === undefined
        ? named(edge.to).version === version
        : satisfies(version, edge.range);
    })
  );
}

export async function plan(
  work: Work,
  published: Published,
  namespace: string,
  how: Bump,
  exact: string | undefined,
  force: boolean,
  /**
   * The edges this version carries. Absent, the publish does not manage them: the files alone
   * decide sameness, as for work that names none. Present, even empty, an edge that changed is
   * a new version too.
   */
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
  });
  // An export's own version is what it is published at, unless `--to` names another.
  const fixed = exact === undefined ? work.exported?.version : undefined;
  const asked = exact ?? fixed;
  // The files and the edges decide sameness: the digest covers the version, so it always moves.
  const probe = await offerFrom(work.path, target(asked ?? "0.1.0"));
  // A version held back gives no files to compare, so it is never the same. An export's own
  // version cannot move, so its edges need only still take what they reach now.
  const sameAs = fixed === undefined ? sameEdges : edgesHold;
  const matches = (held: Current) =>
    held.withheld === undefined &&
    held.digests.join() === probe.digests.join() &&
    (relationships === undefined || sameAs(held.relationships, probe.input.relationships));
  // A version is looked up by itself, whatever its status, so one held back is never taken for new;
  // a pin reaches a draft's files, which a listing withholds.
  const held =
    asked === undefined
      ? undefined
      : asked === current?.version && current.withheld === undefined
        ? current
        : await heldAt(published, namespace, work, asked);
  // Asking again for an export's version already published with these files is a repeat, not a conflict.
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
  const version = same
    ? (asked ?? (current?.version as string))
    : (asked ?? bumpVersion(current?.version, how));
  // The version is not part of the content identity, so the files read once serve it.
  const moved = version === probe.input.version ? probe.input : { ...probe.input, version };
  // What is already published is shown with the edges it carries, not those it was compared with.
  const input =
    same && relationships !== undefined && held !== undefined
      ? { ...moved, relationships: [...(held.relationships ?? [])] }
      : moved;
  return {
    work,
    namespace,
    from: current?.version,
    version,
    same,
    belowLatest: below(version, current?.version),
    input,
  };
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
