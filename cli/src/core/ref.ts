import { isArtifactName, isDeviceName, isVersion } from "#adapter/filespec/names.ts";
import { list, quoted, withoutCredentials } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import { type ArtifactKind, isKind, KINDS } from "./kinds.ts";

/**
 * Breadth by segment count: `kit`, `kit/sales`, then `kit/skill/lint`, `kit/sales/deploy` or `kit/sales/skill/deploy`,
 * which take `@version`. With three, a middle kind reads as a kind, anything else as a namespace.
 */
export interface Ref {
  registry: string;
  /** The namespace asked for, if any. Absent is "wherever it is". */
  namespace?: string | undefined;
  /** Absent for a whole registry or namespace, and for a name whose kind the catalog settles. */
  kind?: ArtifactKind | undefined;
  name?: string | undefined;
  /**
   * The version asked for. Absent tracks whatever the registry calls latest,
   * which is what makes the presence of this field the whole definition of a pin.
   */
  version?: string | undefined;
  /** Explicit local name, when two artifacts would otherwise collide. */
  localName?: string | undefined;
  /** Members a whole registry or namespace leaves out, as addresses relative to it. */
  exclude?: string[] | undefined;
  /** Harnesses this entry projects into, when it narrows the scope's. */
  targets?: string[] | undefined;
  /** Copied into each harness folder rather than linked. */
  copy?: boolean | undefined;
  /**
   * Plugins from a source that is not a registry, by name, that a person agreed may install
   * with the hooks, servers or executables they carry.
   */
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

function segments(input: string, trimmed: string): string[] {
  const parts = trimmed.split("/");
  for (const segment of parts) {
    if (INVALID_SEGMENT.test(segment)) {
      throw new RefParseError(input, `the part ${quoted(segment)} is not valid`);
    }
  }
  return parts;
}

/** Every kind an address may name. A plugin is addressed as the namespace it is. */
const ADDRESSABLE = KINDS.filter((kind) => kind !== "plugin");

/** The one place that turns a kind segment into a kind, so the error reads the same everywhere. */
function kindOf(input: string, segment: string, registry: string, name: string): ArtifactKind {
  // A plugin and the namespace it publishes under are one thing to install, and
  // naming the plugin alone would leave out the loose artifacts beside it.
  if (segment === "plugin") {
    throw new RefParseError(
      input,
      `a plugin is addressed as its namespace. Write ${registry}/${name}`,
    );
  }
  if (isKind(segment)) return segment;
  throw new RefParseError(
    input,
    `${quoted(segment)} is not a kind. The part before the name must be ${list(ADDRESSABLE, "or")}`,
  );
}

/** Splits a trailing `@<version>` off, leaving the address to be segmented. */
function splitVersion(input: string, trimmed: string): { address: string; version?: string } {
  const at = trimmed.indexOf("@");
  if (at === -1) return { address: trimmed };
  if (trimmed.indexOf("@", at + 1) !== -1) {
    throw new RefParseError(input, "an address takes at most one @version");
  }

  const version = trimmed.slice(at + 1);
  if (version === "") throw new RefParseError(input, "no version follows the @");
  // `latest` is what absence already means, so it normalizes away rather than
  // becoming a pin that can never match a published version.
  if (version === LATEST) return { address: trimmed.slice(0, at) };
  if (!isVersion(version)) throw new RefParseError(input, `${quoted(version)} is not a version`);
  return { address: trimmed.slice(0, at), version };
}

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
  // Pinning anything broader than one artifact has no meaning: a namespace's
  // members are versioned one by one, so there is no version to hold them at.
  if (version !== undefined && parts.length < 3) {
    throw new RefParseError(input, "only one artifact can be pinned to a version");
  }

  if (parts.length === 1) return { registry };
  if (parts.length === 2) return { registry, namespace: parts[1] };
  if (parts.length === 3) {
    const middle = parts[1] as string;
    // A kind in the middle reads as a kind; a namespace named like a kind needs all four segments.
    if (isKind(middle) || middle === "plugin") {
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

/** A whole namespace: every artifact its registry publishes under that owner. */
export function isWholeNamespace(ref: Ref): boolean {
  return ref.namespace !== undefined && ref.name === undefined;
}
