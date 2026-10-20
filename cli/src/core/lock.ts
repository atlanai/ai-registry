import { readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { type ArtifactKind, isKind } from "#adapter/index.ts";
import { isSafePath } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { canonicalConfig, type SourceConfig } from "#core/adapter/identity.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { isMissing } from "#core/fs/path.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import type { Roots, Scope } from "#core/store/paths.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import { dict, isRecord, textMapOf, textOf, withoutUndefined } from "./fields.ts";
import { parseYaml } from "./yaml.ts";

export const LOCK_VERSION = 1;

/** `fanout` is a real directory of links, for a harness that will not follow a linked one. */
const LINK_MODES = ["symlink", "junction", "copy", "fanout"] as const;
export type LinkMode = (typeof LINK_MODES)[number];

function isLinkMode(value: string): value is LinkMode {
  return (LINK_MODES as readonly string[]).includes(value);
}

/**
 * A project's lockfile is committed, so a clone chooses it: its paths stay relative and below
 * the scope. The user's own lock may name a scope or harness home outside HOME.
 */
function scopePathOf(value: unknown, scope: Scope): string | undefined {
  const path = textOf(value);
  return path !== undefined && (scope === "user" || isSafePath(path)) ? path : undefined;
}

/** A name becomes one folder under the scope's artifacts. */
function isLeafName(name: string): boolean {
  return isSafePath(name) && !name.includes("/");
}

/**
 * One resolved registry, recorded once and referenced by every artifact from
 * it. A source that versions rows independently leaves `revision` absent.
 */
export interface LockRegistry {
  location: string;
  adapter: string;
  /** Identity of what is being read, not of the code reading it. */
  key: string;
  config: SourceConfig;
  revision: string | undefined;
}

interface LockLink {
  harness: string;
  /** Relative to the scope base, so a committed lock is machine-independent. */
  path: string;
  mode: LinkMode;
  /** A copy's digest as written, so an edit to the harness's own copy is seen. */
  digest?: string | undefined;
}

/**
 * Where the bytes came from when a folder on this machine supplied them. Its
 * presence is what makes a row yours: `publish` sends only these.
 */
interface LockOrigin {
  harness: string;
  /** Relative to the scope base, so the lock stays portable. */
  path: string;
  /** The step that claimed it, so a report can name what to re-run. */
  step: string;
}

export interface LockArtifact {
  /** Key into `registries:`; written as `registry:`. */
  registry: string;
  /** Source-owned and stable across a rename. Absent until a publish assigns one. */
  id: string | undefined;
  /** What the source called it when this was written. */
  name: string;
  kind: ArtifactKind;
  /** The owner inside the source. Absent where the source has none. */
  namespace: string | undefined;
  /** The address the source publishes it at, POSIX separators. Absent until published. */
  address: string | undefined;
  /** Did upstream move? Absent until published. */
  content: string | undefined;
  /** What the source published, where it publishes versions. Display only. */
  version: string | undefined;
  /** A digest of the hooks, servers and executables a plugin carries, when it carries any. */
  carried?: string | undefined;
  /** The commit this artifact was read at, where it is its own rather than its registry's. */
  revision?: string | undefined;
  /** Where our copy lives, relative to the scope base. */
  path: string;
  /** Did you edit it? Digest of this scope's own copy, which is what a harness loads. */
  digest: string;
  /** Set when the bytes come from a folder here, absent when they came from upstream. */
  origin: LockOrigin | undefined;
  /** Prune consults only this list, so a file we never wrote is never removed. */
  links: LockLink[];
  /** Installed names whose `depends_on` edges name this version. Absent when nothing needs it. */
  neededBy?: string[] | undefined;
  /**
   * Links asked for but not made, because something of yours is at the path.
   * Read by status, never by prune: nothing listed here is ours to remove.
   */
  blocked?: { harness: string; path: string; by?: string | undefined }[] | undefined;
}

/**
 * Timestamp-free on purpose: two branches adding different artifacts produce
 * non-overlapping keys, so git merges the lockfile without a conflict.
 */
export interface Lock {
  version: number;
  registries: Record<string, LockRegistry>;
  artifacts: Record<string, LockArtifact>;
}

export function emptyLock(): Lock {
  return { version: LOCK_VERSION, registries: dict(), artifacts: dict() };
}

/** A copy to edit, keyed as safely as the original. */
export function cloneLock(lock: Lock): Lock {
  const copy = structuredClone(lock);
  return {
    ...copy,
    registries: dict(Object.entries(copy.registries)),
    artifacts: dict(Object.entries(copy.artifacts)),
  };
}

function parseRegistry(entry: unknown): LockRegistry | undefined {
  if (!isRecord(entry)) return undefined;
  const location = textOf(entry.source);
  const adapter = textOf(entry.adapter);
  const key = textOf(entry.key);
  if (location === undefined || adapter === undefined || key === undefined) return undefined;
  return {
    location,
    adapter,
    key,
    config: canonicalConfig(textMapOf(entry.config) ?? {}),
    revision: textOf(entry.revision),
  };
}

/** A field only when it has a value, so a row without it reads back as it was written. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

function parseBlocked(raw: unknown, scope: Scope): LockArtifact["blocked"] {
  const held = (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const harness = textOf(entry.harness);
    const path = scopePathOf(entry.path, scope);
    if (harness === undefined || path === undefined) return [];
    const by = textOf(entry.by);
    return [{ harness, path, ...(by === undefined ? {} : { by }) }];
  });
  return held.length === 0 ? undefined : held;
}

/** Undefined when any link is unreadable: prune reads only these, so none may be guessed at. */
function parseLinks(raw: unknown, scope: Scope): LockLink[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  const links: LockLink[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    const harness = textOf(item.harness);
    const path = scopePathOf(item.path, scope);
    const mode = textOf(item.mode);
    const digest = textOf(item.digest);
    if (harness === undefined || path === undefined) return undefined;
    if (mode === undefined || !isLinkMode(mode)) return undefined;
    links.push({ harness, path, mode, ...(digest === undefined ? {} : { digest }) });
  }
  return links;
}

function parseNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.flatMap((item) => textOf(item) ?? []);
  return names.length === 0 ? undefined : [...new Set(names)].sort();
}

function parseOrigin(entry: unknown, scope: Scope): LockOrigin | undefined {
  if (!isRecord(entry)) return undefined;
  const harness = textOf(entry.harness);
  const path = scopePathOf(entry.path, scope);
  if (harness === undefined || path === undefined) return undefined;
  return { harness, path, step: textOf(entry.step) ?? "" };
}

function parseArtifact(entry: unknown, scope: Scope): LockArtifact | undefined {
  if (!isRecord(entry)) return undefined;
  const registry = textOf(entry.registry);
  const kind = textOf(entry.kind);
  const name = textOf(entry.name);
  if (registry === undefined || kind === undefined || !isKind(kind)) return undefined;
  if (name === undefined || !isLeafName(name)) return undefined;
  const path = textOf(entry.path) === undefined ? "" : scopePathOf(entry.path, scope);
  if (path === undefined) return undefined;
  const links = parseLinks(entry.links, scope);
  const origin = parseOrigin(entry.origin, scope);
  // An origin makes a row yours, so one that cannot be read must not pass for none.
  if (links === undefined || (entry.origin != null && origin === undefined)) return undefined;
  return {
    registry,
    id: textOf(entry.id),
    name,
    kind,
    namespace: textOf(entry.namespace),
    address: textOf(entry.address),
    content: textOf(entry.content),
    version: textOf(entry.version),
    ...optional("carried", textOf(entry.carried)),
    ...optional("revision", textOf(entry.revision)),
    path,
    digest: textOf(entry.digest) ?? "",
    origin,
    links,
    neededBy: parseNames(entry.needed_by),
    blocked: parseBlocked(entry.blocked, scope),
  };
}

/** A lockfile that is there but cannot be read. */
export class LockError extends AiregError {
  constructor(message: string, hint: string) {
    super(message, { code: ErrorCode.Invalid, hint });
    this.name = "LockError";
  }
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

function unreadable(path: string, why: string): LockError {
  return new LockError(
    `${path} ${why}.`,
    "Restore it from version control, or delete it and run `aireg install` to write it again.",
  );
}

/**
 * Only an empty file reads as empty. Anything else unreadable is refused: read
 * as empty, the next install would overwrite every edit the lock protects.
 */
export function parseLock(text: string, path = "The lockfile", scope: Scope = "project"): Lock {
  if (CONFLICT_MARKER.test(text)) {
    throw new LockError(
      `${path} has unresolved merge conflict markers.`,
      "Resolve the conflict, then run `aireg install`.",
    );
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    const first = (error as Error).message.split("\n")[0]?.replace(/:$/, "");
    throw unreadable(path, `is not valid YAML: ${first}`);
  }
  if (doc === null || doc === undefined) return emptyLock();
  if (typeof doc !== "object" || Array.isArray(doc)) throw unreadable(path, "is not a lockfile");

  const root = doc as Record<string, unknown>;
  if (typeof root.version === "number" && root.version > LOCK_VERSION) {
    throw new LockError(
      `${path} is lockfile version ${root.version}; this aireg reads version ${LOCK_VERSION}.`,
      "Run `aireg self update`.",
    );
  }
  if (root.version !== LOCK_VERSION) throw unreadable(path, "has no lockfile version aireg reads");

  const lock = emptyLock();
  const registries = section(root.registries, path, "registries");
  const artifacts = section(root.artifacts, path, "artifacts");
  for (const [name, raw] of registries) {
    const registry = parseRegistry(raw);
    if (registry === undefined)
      throw unreadable(path, `has a registry ${quoted(name)} it cannot read`);
    lock.registries[name] = registry;
  }
  for (const [name, raw] of artifacts) {
    const artifact = isSafePath(name) ? parseArtifact(raw, scope) : undefined;
    if (artifact === undefined)
      throw unreadable(path, `has an artifact ${quoted(name)} it cannot read`);
    // An artifact whose registry vanished is unusable; drop it and rebuild.
    // A row from your own folder is yours whether or not anything was installed.
    if (lock.registries[artifact.registry] !== undefined || artifact.origin !== undefined) {
      lock.artifacts[name] = artifact;
    }
  }
  return lock;
}

/** A section left out is empty; one that is there but not a mapping is refused. */
function section(value: unknown, path: string, name: string): [string, unknown][] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) throw unreadable(path, `has a \`${name}:\` that is not a mapping`);
  return Object.entries(value);
}

function registryDoc(source: LockRegistry): Record<string, unknown> {
  return withoutUndefined({
    source: source.location,
    adapter: source.adapter,
    key: source.key,
    config: Object.keys(source.config).length === 0 ? undefined : source.config,
    revision: source.revision,
  });
}

function artifactDoc(artifact: LockArtifact): Record<string, unknown> {
  return withoutUndefined({
    registry: artifact.registry,
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    namespace: artifact.namespace,
    address: artifact.address,
    content: artifact.content,
    version: artifact.version,
    revision: artifact.revision,
    carried: artifact.carried,
    path: artifact.path === "" ? undefined : artifact.path,
    digest: artifact.digest,
    origin:
      artifact.origin === undefined
        ? undefined
        : withoutUndefined({
            harness: artifact.origin.harness,
            path: artifact.origin.path,
            step: artifact.origin.step === "" ? undefined : artifact.origin.step,
          }),
    links: [...artifact.links]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((link) => ({
        harness: link.harness,
        path: link.path,
        mode: link.mode,
        digest: link.mode === "copy" ? link.digest : undefined,
      })),
    needed_by: artifact.neededBy?.length ? [...artifact.neededBy].sort() : undefined,
    blocked: artifact.blocked?.length
      ? [...artifact.blocked].sort((a, b) => a.path.localeCompare(b.path))
      : undefined,
  });
}

/**
 * The registries and rows `after` would write differently from `before`. A row
 * about to be restaged has no digest until its copy lands, so that is no change.
 */
export function lockChanges(before: Lock, after: Lock): string[] {
  const changed = new Set<string>();
  const differ = (a: object | undefined, b: object | undefined) =>
    JSON.stringify(a) !== JSON.stringify(b);
  for (const name of new Set([
    ...Object.keys(before.registries),
    ...Object.keys(after.registries),
  ])) {
    const was = before.registries[name];
    const now = after.registries[name];
    if (differ(was && registryDoc(was), now && registryDoc(now))) changed.add(name);
  }
  for (const name of new Set([...Object.keys(before.artifacts), ...Object.keys(after.artifacts)])) {
    const was = before.artifacts[name];
    const now = after.artifacts[name];
    const landed = now?.digest === "" && was !== undefined ? { ...now, digest: was.digest } : now;
    if (differ(was && artifactDoc(was), landed && artifactDoc(landed))) changed.add(name);
  }
  return [...changed].sort();
}

export function formatLock(lock: Lock): string {
  const registries = dict(
    Object.keys(lock.registries)
      .sort()
      .map((name) => [name, registryDoc(lock.registries[name] as LockRegistry)] as const),
  );
  const artifacts = dict(
    Object.keys(lock.artifacts)
      .sort()
      .map((name) => [name, artifactDoc(lock.artifacts[name] as LockArtifact)] as const),
  );

  const body = stringify(
    { version: LOCK_VERSION, registries, artifacts },
    { indent: 2, defaultStringType: "PLAIN", lineWidth: 0 },
  );
  return `# Generated by aireg. Do not edit.\n${body}`;
}

/** Atomic, so a killed write leaves the old lock or the new one; the caller holds the scope's lease. */
export async function writeLock(roots: Roots, lock: Lock): Promise<void> {
  await guardManagedPath(roots.lock, roots);
  await writeAtomic(roots.lock, formatLock(lock));
}

/** A missing lock is the one state that means nothing is installed. */
export async function readLock(roots: Pick<Roots, "scope" | "lock">): Promise<Lock> {
  const path = roots.lock;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return emptyLock();
    const code = (error as NodeJS.ErrnoException).code;
    throw new LockError(
      `Cannot read ${path} (${code ?? "unknown error"}).`,
      "Check that it is a file you can read.",
    );
  }
  return parseLock(text, path, roots.scope);
}
