import type { RegistryIdentity } from "../contract.ts";
import { type Fields, isRecord, textOf } from "../fields.ts";
import { type ArtifactKind, isKind } from "../kinds.ts";
import { compareVersion, parseVersion, type Version } from "../semver.ts";
import { isVersion } from "../spec/ref.ts";
import { SUPPORTED_FORMAT } from "../spec/types.ts";
import { list, quoted } from "../text.ts";
import { INDEX_DOCUMENT, REGISTRY_DOCUMENT, versionsPath } from "./names.ts";

/** Absent is `undefined`; unreadable throws. */
export type ReadPath = (path: string) => Promise<Uint8Array | undefined>;

interface SpecErrorOptions {
  path?: string | undefined;
  hint?: string | undefined;
  /** Not there, as opposed to there and wrong. */
  missing?: boolean | undefined;
  artifact?: string | undefined;
  cause?: unknown;
}

/** A registry that breaks the file spec. Each adapter reports it as its own failure. */
export class SpecError extends Error {
  /** `not_found` when `missing`, else `invalid`. */
  readonly code: "not_found" | "invalid";
  readonly path: string | undefined;
  readonly hint: string | undefined;
  readonly missing: boolean;
  readonly artifact: string | undefined;

  constructor(message: string, options: SpecErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SpecError";
    this.path = options.path;
    this.hint = options.hint;
    this.missing = options.missing === true;
    this.code = this.missing ? "not_found" : "invalid";
    this.artifact = options.artifact;
  }
}

export async function readJson(read: ReadPath, path: string): Promise<unknown | undefined> {
  const bytes = await read(path);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (cause) {
    // The parser's message quotes registry-chosen bytes, so it stays out of ours.
    throw new SpecError(`${path} is not valid JSON.`, { path, cause });
  }
}

export function object(value: unknown, path: string): Fields {
  if (!isRecord(value)) throw new SpecError(`${path} must be a JSON object.`, { path });
  return value;
}

export interface RegistryDocument {
  formatVersion: number;
  name: string;
  slug: string | undefined;
  description: string | undefined;
  url: string | undefined;
  capabilities: readonly string[];
  /** `blobs/sha256/{digest}` unless the root says otherwise. */
  blobUrl: string;
  kinds: readonly string[];
}

export interface IndexRow {
  namespace: string;
  kind: ArtifactKind;
  name: string;
  latest: string;
  digest: string;
  status: string | undefined;
  description: string | undefined;
}

export interface VersionRow {
  version: string;
  digest: string;
  status: string | undefined;
  yanked: boolean;
  reason: string | undefined;
}

export interface VersionsDocument {
  namespace: string;
  kind: ArtifactKind;
  name: string;
  latest: string;
  versions: readonly VersionRow[];
}

export const DEFAULT_BLOB_URL = "blobs/sha256/{digest}";

export function identityOf(registry: RegistryDocument): RegistryIdentity {
  return {
    name: registry.name,
    ...(registry.slug === undefined ? {} : { slug: registry.slug }),
    ...(registry.description === undefined ? {} : { description: registry.description }),
  };
}

/** Its absence is what makes something not a registry. */
export async function readRegistry(read: ReadPath): Promise<RegistryDocument> {
  const raw = await readJson(read, REGISTRY_DOCUMENT);
  if (raw === undefined) {
    throw new SpecError("This is not a registry: it has no registry.json.", {
      path: REGISTRY_DOCUMENT,
      hint: `Check the address, or create a registry with \`aireg registry init\`.`,
    });
  }
  const entry = object(raw, REGISTRY_DOCUMENT);

  // Section 8: a host document may live at the same place, so check which this is first.
  const kind = textOf(entry.kind);
  if (kind !== undefined && kind !== "registry") {
    throw new SpecError(`registry.json is a ${quoted(kind)} document, not a registry.`, {
      path: REGISTRY_DOCUMENT,
    });
  }

  const formatVersion = entry.format_version;
  if (formatVersion !== SUPPORTED_FORMAT) {
    throw new SpecError(
      `registry.json is format version ${String(formatVersion)}, but this aireg reads version ${SUPPORTED_FORMAT}.`,
      { path: REGISTRY_DOCUMENT },
    );
  }

  const capabilities = Array.isArray(entry.capabilities)
    ? entry.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const kinds = Array.isArray(entry.kinds)
    ? entry.kinds
        .map((item) => (isRecord(item) ? textOf(item.name) : undefined))
        .filter((item): item is string => item !== undefined)
    : [];

  return {
    formatVersion,
    name: text(entry, "name", REGISTRY_DOCUMENT),
    slug: textOf(entry.slug),
    description: textOf(entry.description),
    url: textOf(entry.url),
    capabilities,
    blobUrl: textOf(entry.blob_url) ?? DEFAULT_BLOB_URL,
    kinds,
  };
}

function text(entry: Fields, key: string, path: string): string {
  const value = textOf(entry[key]);
  if (value === undefined) throw new SpecError(`${path} needs a non-empty \`${key}\`.`, { path });
  return value;
}

export async function readIndex(read: ReadPath): Promise<IndexRow[]> {
  const raw = await readJson(read, INDEX_DOCUMENT);
  if (raw === undefined) {
    throw new SpecError("The registry has no index.json.", {
      path: INDEX_DOCUMENT,
      hint: `Run \`aireg registry index\` in the registry.`,
    });
  }
  const entry = object(raw, INDEX_DOCUMENT);
  if (!Array.isArray(entry.entries)) {
    throw new SpecError("index.json has no `entries` list.", { path: INDEX_DOCUMENT });
  }

  const entries: IndexRow[] = [];
  const seen = new Set<string>();
  for (const [at, item] of entry.entries.entries()) {
    const parsed = entryOf(item, `index.json entries[${at}]`);
    if (parsed === undefined) continue;
    // Section 3.2: entries are unique, so a repeat is a broken index, not something to merge.
    const key = `${parsed.namespace}/${parsed.kind}/${parsed.name}`;
    if (seen.has(key))
      throw new SpecError(`index.json lists ${key} twice.`, { path: INDEX_DOCUMENT });
    seen.add(key);
    entries.push(parsed);
  }
  return entries;
}

function entryOf(raw: unknown, at: string): IndexRow | undefined {
  const item = object(raw, at);
  const kind = text(item, "kind", at);
  // Section 5 rule 4: an unknown kind is skipped, not refused.
  if (!isKind(kind)) return undefined;
  return {
    namespace: text(item, "namespace", at),
    kind,
    name: text(item, "name", at),
    latest: text(item, "latest", at),
    digest: text(item, "digest", at),
    status: textOf(item.status),
    description: textOf(item.description),
  };
}

export async function readVersions(
  read: ReadPath,
  namespace: string,
  kind: ArtifactKind,
  name: string,
): Promise<VersionsDocument> {
  const path = versionsPath(namespace, kind, name);
  const raw = await readJson(read, path);
  if (raw === undefined) throw new SpecError(`${path} is missing.`, { path, missing: true });
  const entry = object(raw, path);
  if (!Array.isArray(entry.versions))
    throw new SpecError(`${path} has no \`versions\` list.`, { path });

  const versions: VersionRow[] = [];
  for (const [at, item] of entry.versions.entries()) {
    const version = object(item, `${path} versions[${at}]`);
    const named = text(version, "version", path);
    if (!isVersion(named))
      throw new SpecError(`${path} has an invalid version, ${quoted(named)}.`, { path });
    versions.push({
      version: named,
      digest: text(version, "digest", path),
      status: textOf(version.status),
      yanked: version.yanked === true,
      reason: textOf(version.reason),
    });
  }

  const latest = text(entry, "latest", path);
  if (!versions.some((item) => item.version === latest)) {
    throw new SpecError(`${path} names a latest version it does not list.`, { path });
  }
  return { namespace, kind, name, latest, versions };
}

/** How many versions a refusal suggests; `versions.json` lists the newest first. */
const SUGGESTED = 5;

/** Does not skip yanked or unreleased rows; an unlisted version throws. */
export function resolveVersion(document: VersionsDocument, wanted: string | undefined): VersionRow {
  const version = wanted ?? document.latest;
  const found = document.versions.find((item) => item.version === version);
  if (found !== undefined) return found;
  const artifact = [document.namespace, document.name].filter(Boolean).join("/");
  const offered = document.versions.filter((item) => !item.yanked).map((item) => item.version);
  const more = offered.length > SUGGESTED ? `, or another of its ${offered.length} versions` : "";
  // A version that was never released is a wrong name, not a broken registry.
  throw new SpecError(`${artifact} has no version ${version}.`, {
    path: versionsPath(document.namespace, document.kind, document.name),
    missing: wanted !== undefined,
    artifact,
    hint:
      offered.length === 0 ? undefined : `Use ${list(offered.slice(0, SUGGESTED), "or")}${more}.`,
  });
}

/** Includes yanked releases, so a publish never reuses one. */
export function newestListed(document: VersionsDocument): string {
  let best: { version: string; parsed: Version } | undefined;
  for (const { version } of document.versions) {
    const parsed = parseVersion(version);
    if (parsed === undefined) continue;
    if (best === undefined || compareVersion(parsed, best.parsed) > 0) best = { version, parsed };
  }
  return best?.version ?? document.latest;
}
