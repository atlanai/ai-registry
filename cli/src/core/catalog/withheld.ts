import type { Withheld as Reported } from "#adapter/contract.ts";
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
};

/** `engineering/pr-review 1.2.0 is blocked (leaks tokens)`, to end a sentence with. */
export function withheldMessage(item: Withheld): string {
  const shown = [item.group, item.name].filter(Boolean).join("/");
  const why = item.reason === undefined ? "" : ` (${item.reason})`;
  return `${shown} ${item.version} ${WORDS[item.status] ?? `is ${item.status}`}${why}`;
}
