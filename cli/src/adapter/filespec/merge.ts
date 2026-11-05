import { isRecord } from "../fields.ts";
import type { ArtifactKind } from "../kinds.ts";
import { compareVersion, parseVersion, type Version } from "../semver.ts";
import { isVersion } from "../spec/ref.ts";
import { SUPPORTED_FORMAT } from "../spec/types.ts";
import { quoted } from "../text.ts";
import { SpecError } from "./documents.ts";
import { INDEX_DOCUMENT, versionsPath } from "./names.ts";

/**
 * Section 3.3: highest active, non-yanked semver, so a backport never becomes latest. Equals,
 * and versions that do not parse, keep the first row, since the list is newest first.
 */
export function newest(versions: readonly unknown[]): string | undefined {
  let best: { version: string; parsed: Version | undefined } | undefined;
  for (const item of versions) {
    const { version, status, yanked } = item as Record<string, unknown>;
    if (typeof version !== "string" || status !== "active" || yanked === true) continue;
    const parsed = parseVersion(version);
    const outranks =
      best === undefined ||
      tier(parsed) > tier(best.parsed) ||
      (parsed !== undefined &&
        best.parsed !== undefined &&
        tier(parsed) === tier(best.parsed) &&
        compareVersion(parsed, best.parsed) > 0);
    if (outranks) best = { version, parsed };
  }
  return best?.version;
}

/** One version an offer is publishing. */
export interface OfferedVersion {
  namespace: string;
  kind: ArtifactKind;
  name: string;
  version: string;
  /** The envelope's content digest, which `versions.json` has to match. */
  digest: string;
  description?: string | undefined;
  /** The row's status in `versions.json`; `active` unless a status change set another. */
  status?: string | undefined;
  /** The row's `catalog_digest`, when it has one; `index.json` repeats it. */
  catalogDigest?: string | undefined;
}

/** A release outranks every prerelease, and a prerelease every version that does not parse. */
function tier(parsed: Version | undefined): number {
  if (parsed === undefined) return 0;
  return parsed.prerelease.length === 0 ? 2 : 1;
}

/**
 * Re-offering replaces that one entry; `latest` is recomputed over them all. Merged over
 * raw JSON, so a field the spec adds later and `published_at` survive.
 */
export function mergedVersions(
  existing: unknown | undefined,
  offered: OfferedVersion,
  publishedAt: string,
): Record<string, unknown> {
  const path = versionsPath(offered.namespace, offered.kind, offered.name);
  if (!isVersion(offered.version)) {
    throw new SpecError(`${path} cannot take an invalid version, ${quoted(offered.version)}.`, {
      path,
    });
  }
  const document = existing === undefined ? {} : objectAt(existing, path);
  const versions = entriesOf(document, "versions", path);

  const at = versions.findIndex(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).version === offered.version,
  );
  const previous = at === -1 ? undefined : objectAt(versions[at], `${path} versions[${at}]`);

  // Bytes this version already pins leave the row as it was, `published_at` included, so an
  // identical offer never looks like a new publish.
  const unchanged = previous !== undefined && previous.digest === offered.digest;
  const entry = unchanged
    ? previous
    : {
        ...previous,
        version: offered.version,
        digest: offered.digest,
        published_at: publishedAt,
        status: "active",
        yanked: false,
      };
  const next =
    at === -1
      ? versions.toSpliced(rowAt(versions, offered.version), 0, entry)
      : versions.with(at, entry);

  return {
    ...document,
    namespace: offered.namespace,
    kind: offered.kind,
    name: offered.name,
    latest: newest(next) ?? offered.version,
    versions: next,
  };
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SpecError(`${path} is not a JSON object.`, { path });
  return value;
}

function entriesOf(document: Record<string, unknown>, key: string, path: string): unknown[] {
  const list = document[key];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new SpecError(`${path} needs \`${key}\` to be a list.`, { path });
  return list;
}

/** Section 3.3 lists newest first: a new row goes above the first version it outranks. */
function rowAt(versions: readonly unknown[], version: string): number {
  const parsed = parseVersion(version);
  if (parsed === undefined) return 0;
  const at = versions.findIndex((item) => {
    const other = isRecord(item) && typeof item.version === "string" ? item.version : undefined;
    const ranked = other === undefined ? undefined : parseVersion(other);
    return ranked !== undefined && compareVersion(parsed, ranked) > 0;
  });
  return at === -1 ? versions.length : at;
}

/**
 * `index.json` with each offered artifact upserted. Callers offer only a version that became
 * `latest`, so rows agree with `versions.json`; rows not offered are left exactly as they were.
 */
export function mergedIndex(
  existing: unknown | undefined,
  offered: readonly OfferedVersion[],
  generatedAt: string,
): Record<string, unknown> {
  const document = existing === undefined ? {} : objectAt(existing, INDEX_DOCUMENT);
  const rows = entriesOf(document, "entries", INDEX_DOCUMENT).map((item, at) =>
    objectAt(item, `index.json entries[${at}]`),
  );

  // Indexed once, so upserting every artifact of a large publish stays linear.
  const at = new Map(rows.map((row, index) => [rowKey(row), index]));
  let moved = false;
  for (const item of offered) {
    const row = {
      namespace: item.namespace,
      kind: item.kind,
      name: item.name,
      latest: item.version,
      digest: item.digest,
      status: item.status ?? "active",
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.catalogDigest === undefined ? {} : { catalog_digest: item.catalogDigest }),
    };
    const index = at.get(rowKey(row));
    if (index === undefined) {
      at.set(rowKey(row), rows.length);
      rows.push(row);
      moved = true;
      continue;
    }
    const merged: Record<string, unknown> = { ...rows[index], ...row };
    // The entry repeats its latest row's catalog_digest, so an older row's is dropped.
    if (item.catalogDigest === undefined) merged.catalog_digest = undefined;
    if (JSON.stringify(merged) === JSON.stringify(rows[index])) continue;
    rows[index] = merged;
    moved = true;
  }

  // Stamped only when the catalog moved: an offer that changes nothing must serialize
  // byte-identically, or every repeat push looks like new work to git.
  const stamp = moved ? generatedAt : (document.generated_at ?? generatedAt);
  return {
    ...document,
    format_version: SUPPORTED_FORMAT,
    generated_at: stamp,
    entries: rows,
  };
}

/** Same (namespace, kind, name) is the same catalog row; §3.2 keeps it unique. */
function rowKey(row: Record<string, unknown>): string {
  return `${String(row.namespace)}\u0000${String(row.kind)}\u0000${String(row.name)}`;
}

/** Two spaces and a trailing newline, matching every other document we write. */
export function specJson(document: unknown): string {
  return `${JSON.stringify(document, undefined, 2)}\n`;
}
