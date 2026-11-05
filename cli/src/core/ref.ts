import { isArtifactName, isDeviceName, isKindSegment } from "#adapter/filespec/names.ts";
import { type ArtifactKind, isBuiltinKind } from "#adapter/kinds.ts";
import { isVersion } from "#adapter/spec/ref.ts";
import { list, quoted, withoutCredentials } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import { knownKinds } from "./kinds.ts";

/** A whole registry, a whole namespace, or one artifact, which alone takes `@version`. */
export interface Ref {
  registry: string;
  /** Absent means wherever it is. */
  namespace?: string | undefined;
  /** Absent for a whole registry or namespace, and for a name whose kind the catalog settles. */
  kind?: ArtifactKind | undefined;
  name?: string | undefined;
  /** The version asked for; absent tracks the registry's latest, so this alone makes a pin. */
  version?: string | undefined;
  /** Explicit local name, when two artifacts would otherwise collide. */
  localName?: string | undefined;
  /** Members a whole registry or namespace leaves out, as addresses relative to it. */
  exclude?: string[] | undefined;
  /** Targets this entry projects into, when it narrows the scope's. */
  targets?: string[] | undefined;
  /** Copied into each target folder rather than linked. */
  copy?: boolean | undefined;
  /** Non-registry plugins a person let install with the hooks or servers they carry. */
  trust?: string[] | undefined;
}

export class RefParseError extends AiregError {
  constructor(input: string, reason: string) {
    super(`Cannot read the address ${quoted(withoutCredentials(input))}: ${reason}.`, {
      code: ErrorCode.Usage,
    });
    this.name = "RefParseError";
  }
}

const INVALID_SEGMENT = /^$|^\.\.?$|[\\@]/;

/** Spelled by omission, and accepted spelled out because every package manager takes it. */
const LATEST = "latest";

export function parseRef(input: string): Ref {
  const trimmed = input.trim();
  if (trimmed === "") throw new RefParseError(input, "it is empty");

  const { address, version } = splitVersion(input, trimmed);
  const parts = segments(input, address);
  const registry = parts[0] as string;
  const pinned = version === undefined ? {} : { version };

  if (parts.length > 4) {
    throw new RefParseError(
      input,
      "it has too many parts; an address is at most <registry>/<namespace>/<kind>/<name>",
    );
  }
  // A namespace's members are versioned one by one, so there is no version to hold them at.
  if (version !== undefined && parts.length < 3) {
    throw new RefParseError(input, "only one artifact can be pinned to a version");
  }

  if (parts.length === 1) return { registry };
  if (parts.length === 2) return { registry, namespace: parts[1] };
  if (parts.length === 3) {
    const middle = parts[1] as string;
    // Only a built-in reads as a kind here, so loading an adapter never changes what a ref means.
    if (isBuiltinKind(middle)) {
      const name = parts[2] as string;
      return { registry, kind: kindOf(input, middle, registry, name), name, ...pinned };
    }
    return { registry, namespace: middle, name: parts[2], ...pinned };
  }
  return {
    registry,
    namespace: parts[1],
    kind: kindOf(input, parts[2] as string, registry, parts[3] as string),
    name: parts[3],
    ...pinned,
  };
}

function splitVersion(input: string, trimmed: string): { address: string; version?: string } {
  const at = trimmed.indexOf("@");
  if (at === -1) return { address: trimmed };
  if (trimmed.indexOf("@", at + 1) !== -1) {
    throw new RefParseError(input, "an address takes at most one @version");
  }

  const version = trimmed.slice(at + 1);
  if (version === "") throw new RefParseError(input, "no version follows the @");
  // `latest` is what absence means, so it normalizes away rather than pinning to no version.
  if (version === LATEST) return { address: trimmed.slice(0, at) };
  if (!isVersion(version)) throw new RefParseError(input, `${quoted(version)} is not a version`);
  return { address: trimmed.slice(0, at), version };
}

function segments(input: string, trimmed: string): string[] {
  const parts = trimmed.split("/");
  for (const segment of parts) {
    if (INVALID_SEGMENT.test(segment)) {
      throw new RefParseError(input, `the part ${quoted(segment)} is not valid`);
    }
  }
  return parts;
}

function kindOf(input: string, segment: string, registry: string, name: string): ArtifactKind {
  // A plugin and the namespace it publishes under are one thing to install, and
  // naming the plugin alone would leave out the loose artifacts beside it.
  if (segment === "plugin") {
    throw new RefParseError(
      input,
      `a plugin is addressed as its namespace. Write ${registry}/${name}`,
    );
  }
  // Any kind in the grammar parses, so a row of a kind no adapter declares stays readable.
  if (isKindSegment(segment)) return segment;
  // A plugin is addressed as the namespace it is.
  const addressable = knownKinds().filter((kind) => kind !== "plugin");
  throw new RefParseError(
    input,
    `${quoted(segment)} is not a kind. The part before the name must be ${list(addressable, "or")}`,
  );
}

export function withLocalName(ref: Ref, localName: string): Ref {
  const name = localName.trim();
  if (ref.name === undefined) {
    throw new RefParseError(
      formatRef(ref),
      ref.namespace === undefined
        ? "a whole registry cannot have one local name"
        : "a whole namespace cannot have one local name",
    );
  }
  // It names a folder, so it is held to the spec's name grammar, which no two case variants share.
  if (!isArtifactName(name) || isDeviceName(name)) {
    throw new AiregError(`${quoted(name)} cannot be a local name.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and inner hyphens, such as my-review.",
    });
  }
  return { ...ref, localName: name };
}

export function withExclusions(ref: Ref, exclude: readonly string[]): Ref {
  if (ref.name !== undefined) {
    throw new RefParseError(
      formatRef(ref),
      "only a whole registry or namespace can exclude artifacts",
    );
  }
  const kept = [...new Set(exclude)].sort();
  return kept.length === 0 ? { ...ref, exclude: undefined } : { ...ref, exclude: kept };
}

/** Where one member sits relative to a whole ref, which is how an exclusion names it. */
export function relativeTo(
  ref: Ref,
  member: { namespace?: string | undefined; kind: string; name: string },
): string {
  const namespace = ref.namespace === undefined ? member.namespace : undefined;
  return [namespace, member.kind, member.name].filter(Boolean).join("/");
}

/** The address alone, which is the identity two refs are the same artifact by. */
export function formatAddress(ref: Ref): string {
  return [ref.registry, ref.namespace, ref.kind, ref.name]
    .filter((part): part is string => part !== undefined)
    .join("/");
}

export function formatRef(ref: Ref): string {
  const address = formatAddress(ref);
  return ref.version === undefined ? address : `${address}@${ref.version}`;
}

/** The name the artifact is installed under. */
export function refName(ref: Ref): string {
  return ref.localName ?? ref.name ?? ref.namespace ?? ref.registry;
}

export function isWholeRegistry(ref: Ref): boolean {
  return ref.namespace === undefined && ref.name === undefined;
}

export function isWholeNamespace(ref: Ref): boolean {
  return ref.namespace !== undefined && ref.name === undefined;
}
