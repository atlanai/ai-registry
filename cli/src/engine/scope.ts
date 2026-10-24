import { list } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { Ref } from "#core/ref.ts";
import { formatAddress, isWholeNamespace, isWholeRegistry, parseRef } from "#core/ref.ts";
import type { Candidate } from "#core/sync/adopt.ts";
import type { SyncItem } from "#core/sync/model.ts";
import { artifactKey } from "./decide.ts";
import type { RunScope } from "./inspect.ts";
import type { Scan } from "./scan.ts";

/** Typed so a caller can tell a mistyped address from a run with no work. */
export class RunScopeError extends AiregError {
  readonly refs: readonly string[];

  constructor(refs: readonly string[]) {
    // A run records only its message, so the way out is part of it.
    super(
      `${list(refs)} ${refs.length === 1 ? "matches" : "match"} nothing this job covers. ` +
        "Name an artifact as `<registry>/<namespace>/<kind>/<name>`, or by the name its runs show.",
      { code: ErrorCode.NotFound },
    );
    this.name = "RunScopeError";
    this.refs = refs;
  }
}

/** `<namespace>/<name>`, or a bare name when the registry groups it under none. */
function split(name: string): { namespace: string | undefined; leaf: string } {
  const cut = name.lastIndexOf("/");
  if (cut < 0) return { namespace: undefined, leaf: name };
  return { namespace: name.slice(0, cut), leaf: name.slice(cut + 1) };
}

/** The address that reaches only this kind of a run's artifact, never another of its name. */
export function kindAddress(registry: string, kind: ArtifactKind, name: string): string {
  const { namespace, leaf } = split(name);
  return formatAddress({ registry, namespace, kind, name: leaf });
}

function matchesItem(ref: Ref, registry: string, item: SyncItem, scan: Scan): boolean {
  // Both sides: the ref has to name this job's registry, and the item has
  // to come from it. Another account's catalog is not this run's to narrow.
  if (ref.registry !== registry || item.source !== registry) return false;
  const { namespace: named, leaf } = split(item.name);
  // An installed artifact's lock key is usually its bare name; its row records the namespace.
  const namespace = named ?? scan.pinned?.artifacts[item.name]?.namespace;
  if (isWholeRegistry(ref)) return true;
  if (isWholeNamespace(ref)) return ref.namespace === namespace;
  if (ref.kind !== item.kind || ref.name !== leaf) return false;
  // An address that names no namespace means "wherever it is", the same
  // reading `plan/select.ts` gives it.
  return ref.namespace === undefined || ref.namespace === namespace;
}

/**
 * A local artifact has no namespace to match on, so a whole registry or
 * namespace never adopts one by implication.
 */
function matchesCandidate(ref: Ref, registry: string, candidate: Candidate): boolean {
  if (ref.registry !== registry || ref.name !== candidate.name) return false;
  return ref.kind === undefined || ref.kind === candidate.kind;
}

/**
 * Artifacts this one ref reaches, in the keys `classify` keys outcomes by: a ref
 * that names a kind reaches only that kind, and one that names none, every kind.
 */
function reached(raw: string, registry: string, scan: Scan): Set<string> {
  const keys = new Set<string>();
  // The catalog name is what a run's events name, so it is accepted alongside the address grammar.
  for (const item of scan.items) {
    if (item.source === registry && item.name === raw) keys.add(artifactKey(item.kind, item.name));
  }
  for (const candidate of scan.local) {
    if (candidate.name === raw) keys.add(artifactKey(candidate.kind, candidate.name));
  }

  let ref: Ref;
  try {
    ref = parseRef(raw);
  } catch {
    // Not an address; the exact-name pass above was its only reading.
    return keys;
  }
  for (const item of scan.items) {
    if (matchesItem(ref, registry, item, scan)) keys.add(artifactKey(item.kind, item.name));
  }
  for (const candidate of scan.local) {
    if (matchesCandidate(ref, registry, candidate)) {
      keys.add(artifactKey(candidate.kind, candidate.name));
    }
  }
  return keys;
}

/**
 * `undefined` covers everything the job does. Throws when any ref reached
 * nothing, so a run cannot report success for work it never looked at.
 */
export function scopedKeys(
  refs: RunScope,
  scan: Scan,
  registry: string,
): ReadonlySet<string> | undefined {
  if (refs === undefined) return undefined;
  const keys = new Set<string>();
  const missed: string[] = [];
  for (const raw of refs) {
    const found = reached(raw, registry, scan);
    if (found.size === 0) {
      missed.push(raw);
      continue;
    }
    for (const key of found) keys.add(key);
  }
  if (missed.length > 0) throw new RunScopeError(missed);
  return keys;
}
