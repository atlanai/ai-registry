import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { credentialFor } from "#accounts/credentials.ts";
import { isArtifactName, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import type { Artifact, PublishInput, SourceAdapter } from "#adapter/index.ts";
import { type Bump, bumpVersion, parseVersion } from "#adapter/semver.ts";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import { ID as LOCAL } from "#adapters/local/api.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor, declaredLayout } from "#core/adapter/registry.ts";
import { type ConnectedSource, connectSource, resolveArtifacts } from "#core/adapter/source.ts";
import { readOnlyLayout } from "#core/adapter/writable.ts";
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

/** What one registry publishes now, read once and kept open to publish into. */
export interface Published {
  alias: string;
  location: string;
  source: ConnectedSource;
  namespaces: string[];
  latest: Map<string, { id: string; version: string | undefined; digests: string[] }>;
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
      layout: declaredLayout(declared.config),
    },
    credential === undefined ? {} : { credential },
  );
  if (source.handle.publish === undefined) {
    await source.handle.close();
    throw cannotPublish(source.adapter, alias, how);
  }
  const listing = await resolveArtifacts(source, [], { all: true });
  const latest = new Map<string, { id: string; version: string | undefined; digests: string[] }>();
  const namespaces = new Set<string>();
  for (const { artifact } of listing.listed) {
    const { namespace, name, version } = artifact.envelope.metadata;
    if (namespace === undefined) continue;
    namespaces.add(namespace);
    latest.set(keyOf(namespace, artifact.kind, name), {
      id: artifact.id,
      version,
      digests: digestsOf(artifact),
    });
  }
  return { alias, location, source, namespaces: [...namespaces].sort(), latest };
}

/** One artifact's outcome: a first version, the next one, or already there. */
export interface Planned {
  work: Work;
  namespace: string;
  from: string | undefined;
  version: string;
  same: boolean;
  input: PublishInput;
}

/** An exact version must be new: a published version directory is never rewritten. */
async function taken(published: Published, name: string, version: string): Promise<boolean> {
  try {
    const found = await published.source.handle.resolve([{ name, version }]);
    return found.artifacts.length > 0;
  } catch {
    return false;
  }
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

export async function plan(
  work: Work,
  published: Published,
  namespace: string,
  how: Bump,
  exact: string | undefined,
  force: boolean,
): Promise<Planned> {
  const current = published.latest.get(keyOf(namespace, work.kind, work.name));
  const folder = published.source.adapter.capabilities.fileSpec === true;
  // An edit made on an older version, published as the newest, drops whatever
  // was published in between; that is a conflict, the same one sync reports.
  const behind =
    work.base !== undefined && current?.version !== undefined && work.base !== current.version;
  if (behind && !force) {
    throw new AiregError(
      `${work.name} was edited from ${work.base}, but ${current.version} was published since, so publishing would drop the changes in ${current.version}.`,
      {
        code: ErrorCode.Changed,
        hint: `Install ${current.version} first and redo the edit there, or pass \`--force\` to publish over it.`,
      },
    );
  }
  const target = (version: string): OfferTarget => ({
    name: work.name,
    kind: work.kind,
    namespace,
    version,
    id: current?.id,
    description: work.description,
    asAgentDocument: folder,
  });
  // The files decide sameness: the digest covers the version, so it always moves.
  const probe = await offerFrom(work.path, target(exact ?? "0.1.0"));
  const same =
    current !== undefined && current.digests.join() === probe.digests.join() && exact === undefined;
  if (exact !== undefined && (await taken(published, work.name, exact))) {
    throw new AiregError(`${namespace}/${work.name}@${exact} is already published.`, {
      code: ErrorCode.Conflict,
      hint: "Choose a new version, or leave the version off; a published version is never rewritten.",
    });
  }
  if (!same) await refuseInvalid(work, namespace, probe.input, folder);
  // Without SemVer there is no "next" to work out, and 0.1.0 would sort below it.
  if (
    !same &&
    exact === undefined &&
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
    ? (current?.version as string)
    : (exact ?? bumpVersion(current?.version, how));
  // The version is not part of the content identity, so the files read once serve it.
  const input = version === probe.input.version ? probe.input : { ...probe.input, version };
  return { work, namespace, from: current?.version, version, same, input };
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
