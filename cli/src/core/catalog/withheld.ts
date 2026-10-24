import type { Withheld as Reported, Newest as ReportedNewest } from "#adapter/contract.ts";
import { compareVersion, parseVersion } from "#adapter/semver.ts";
import { sanitizeName, sanitizeText } from "#adapter/text.ts";
import { type ArtifactKind, isKind } from "#core/kinds.ts";

/** An artifact a registry reached but would not serve at that version, by its status. */
export interface Withheld {
  name: string;
  group: string | undefined;
  kind: ArtifactKind;
  version: string;
  status: string;
  reason: string | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** What an adapter reported, checked and named as catalog entries are. */
export function withheldFrom(reported: unknown): Withheld[] {
  if (!Array.isArray(reported)) return [];
  return reported.flatMap((item: Partial<Reported>) => {
    const [name, version, status] = [text(item?.name), text(item?.version), text(item?.status)];
    if (name === undefined || version === undefined || status === undefined) return [];
    if (typeof item.kind !== "string" || !isKind(item.kind)) return [];
    const group = text(item.namespace);
    const reason = text(item.reason);
    return [
      {
        name: sanitizeName(name),
        group: group === undefined ? undefined : sanitizeName(group),
        kind: item.kind,
        version: sanitizeText(version),
        status: sanitizeText(status),
        reason: reason === undefined ? undefined : sanitizeText(reason),
      },
    ];
  });
}

/** The newest version a registry holds of one artifact, whatever its status, a yanked one included. */
export interface Newest {
  name: string;
  group: string | undefined;
  kind: ArtifactKind;
  version: string;
}

/** What an adapter reported as each artifact's newest version, checked as withheld ones are. */
export function newestFrom(reported: unknown): Newest[] {
  if (!Array.isArray(reported)) return [];
  return reported.flatMap((item: Partial<ReportedNewest>) => {
    const [name, version] = [text(item?.name), text(item?.version)];
    if (name === undefined || version === undefined) return [];
    if (typeof item.kind !== "string" || !isKind(item.kind)) return [];
    const group = text(item.namespace);
    return [
      {
        name: sanitizeName(name),
        group: group === undefined ? undefined : sanitizeName(group),
        kind: item.kind,
        version: sanitizeText(version),
      },
    ];
  });
}

/** Count past the newest held version, including yanked releases, to avoid reusing a version. */
export function countPast(
  version: string | undefined,
  newest: readonly Newest[] | undefined,
  at: { name: string; group: string | undefined; kind: ArtifactKind },
): string | undefined {
  const name = sanitizeName(at.name);
  const group = at.group === undefined ? undefined : sanitizeName(at.group);
  const held = newest?.find(
    (item) =>
      item.name === name &&
      item.kind === at.kind &&
      (item.group === undefined || item.group === group),
  )?.version;
  const above = held === undefined ? undefined : parseVersion(held);
  if (held === undefined || above === undefined) return version;
  const now = version === undefined ? undefined : parseVersion(version);
  // A version that is not SemVer has no next one, so it stays for the caller to refuse.
  if (version !== undefined && now === undefined) return version;
  return now === undefined || compareVersion(above, now) > 0 ? held : version;
}

/** The withheld artifact an address names; one with no namespace or kind matches any. */
export function withheldAt(
  withheld: readonly Withheld[] | undefined,
  at: { name?: string | undefined; group?: string | undefined; kind?: ArtifactKind | undefined },
): Withheld | undefined {
  const name = at.name === undefined ? undefined : sanitizeName(at.name);
  const group = at.group === undefined ? undefined : sanitizeName(at.group);
  return withheld?.find(
    (item) =>
      item.name === name &&
      (group === undefined || item.group === group) &&
      (at.kind === undefined || item.kind === at.kind),
  );
}

const WORDS: Readonly<Record<string, string>> = {
  blocked: "is blocked",
  draft: "is a draft",
  pending_review: "is pending review",
  deprecated: "is deprecated",
  archived: "is archived",
};

/** Statuses only a pin reaches, which say so when one does. */
const PINNED_ONLY = new Set(["draft", "pending_review"]);

/** `is blocked (leaks tokens)`: what the status says of the version, to end a sentence with. */
export function statusClause(item: Withheld): string {
  const why = item.reason === undefined ? "" : ` (${item.reason})`;
  return `${WORDS[item.status] ?? `is ${item.status}`}${why}`;
}

/** `engineering/pr-review 1.2.0 is blocked (leaks tokens)`, to end a sentence with. */
export function withheldMessage(item: Withheld): string {
  const shown = [item.group, item.name].filter(Boolean).join("/");
  return `${shown} ${item.version} ${statusClause(item)}`;
}

/** What a run installing a version of this status says: `acme/lint 1.1.0 is deprecated (superseded).` */
export function statusWarning(item: Withheld): string {
  const pinned = PINNED_ONLY.has(item.status) ? ", and installs only because it is pinned" : "";
  return `${withheldMessage(item)}${pinned}.`;
}
