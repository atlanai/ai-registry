import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { digestHex } from "#adapter/spec/ref.ts";
import { sanitizeName } from "#adapter/text.ts";
import { setting } from "#core/env.ts";
import { canonical } from "#core/fs/canonical.ts";
import { isSha256Hex, sha256Hex, shortHash } from "#core/fs/hash.ts";
import { PRIVATE_DIR } from "#core/fs/mode.ts";
import { homeDir } from "#core/fs/path.ts";
import { type ArtifactKind, kindDir, stagedLeaf } from "#core/kinds.ts";
import { HOME_DIR, LEGACY_TARGETS_DIR, TARGETS_DIR } from "#core/product.ts";

/** Where a command installs: this project, or `-g` for the user. */
export const SCOPES = ["user", "project"] as const;
export type Scope = (typeof SCOPES)[number];

/** The one folder each scope keeps its manifest, lock and installed copies in. */
export const SCOPE_DIR = ".registry";
export const MANIFEST_FILE = "manifest.yml";
const LOCK_FILE = "manifest.lock.yml";

export interface Roots {
  scope: Scope;
  /** Project directory; also what relative link paths in the lock resolve against. */
  cwd: string;
  /** Paths recorded in the lock are relative to this, so the file stays portable. */
  base: string;
  manifest: string;
  lock: string;
  /**
   * This scope's only content tree. Use `namespaceDir`, `artifactPath` and
   * `projectionDir` rather than joining onto it.
   */
  artifacts: string;
  /** Apply journal, deleted once the lock is written. */
  applyJournal: string;
}

/** The tool's own files: `AIREG_HOME`, else `~/.aireg`. Nothing you install lives here. */
export function toolHome(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(toolHomeRoot(env));
}

/** Caller-selected location before filesystem aliases are resolved. */
export function toolHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return setting("HOME", env) ?? join(homeDir(env), HOME_DIR);
}

/**
 * Creates the home owner-only before anything goes in it, whatever the umask: stored
 * credentials are refused under a home other users can write to. An existing one keeps its mode.
 */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = toolHome(env);
  mkdirSync(home, { recursive: true, mode: PRIVATE_DIR });
  return home;
}

/**
 * The user scope's folder, where `-g` installs: `AIREG_USER_SCOPE`, else
 * `~/.registry`. Set on its own, never worked out from `AIREG_HOME`.
 */
export function userScopeDir(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(setting("USER_SCOPE", env) ?? join(homeDir(env), SCOPE_DIR));
}

/** Tokens aireg stores itself, owner-only and apart from `config.yml`. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "credentials.json");
}

/** Signed adapter modules, one directory per id and version. */
export function adaptersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "adapters");
}

/** Target definitions of your own, one JSON file each. */
export function targetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), TARGETS_DIR);
}

/** The folder aireg 0.1 keeps target definitions in, still read beside `targetsDir`. */
export function legacyTargetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), LEGACY_TARGETS_DIR);
}

/**
 * Sibling of `adapters/<id>/<version>/`, never inside it: unpin deletes the
 * version directories only, and these files must survive a version swap.
 */
export function adapterDataDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(adaptersDir(env), id);
}

export function adapterModulePath(
  id: string,
  version: string,
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(adapterDataDir(id, env), version, filename);
}

/** The user scope's leases, outside its tree so they survive that tree being replaced. */
export function leasesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "leases");
}

/** In aireg's home, not the scope: recovery deletes what it names, and a clone could ship one. */
function journalPath(dir: string, env: NodeJS.ProcessEnv): string {
  const scope = join(canonical(dirname(dir)), basename(dir));
  const key = shortHash(scope);
  return join(toolHome(env), "journals", `${key}.json`);
}

export function roots(scope: Scope, cwd: string, env: NodeJS.ProcessEnv = process.env): Roots {
  const user = scope === "user";
  const dir = user ? userScopeDir(env) : join(cwd, SCOPE_DIR);
  return {
    scope,
    cwd,
    // Canonical, like the home it is paired with: an artifacts tree under a
    // symlinked root would otherwise make every recorded path escape upwards.
    base: user ? homeDir(env) : cwd,
    manifest: join(dir, MANIFEST_FILE),
    lock: join(dir, LOCK_FILE),
    artifacts: join(dir, "artifacts"),
    applyJournal: journalPath(dir, env),
  };
}

/** Scope is positional rather than declared: the user scope's folder, else a project. */
export function scopeFor(root: string, env: NodeJS.ProcessEnv = process.env): Scope {
  return resolve(canonical(root)) === userScopeDir(env) ? "user" : "project";
}

/**
 * The fetch cache: one clone per repository, kept between runs so the next fetch
 * is incremental. Deleting it costs a refetch and nothing else.
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "cache");
}

/**
 * Reserved directory at the artifacts root. Dot-prefixed so it cannot collide
 * with a registry alias, which `sanitizeName` never leaves dotted.
 */
export const PROJECTIONS_DIR = ".projections";

/** Everything one registry put in this scope. Its children are namespaces. */
export function registryDir(roots: Pick<Roots, "artifacts">, source: string): string {
  return join(roots.artifacts, sanitizeName(source));
}

/**
 * One namespace of one registry: content and nothing else. No manifests, no
 * generated files, no packaging - those live in the projection beside it.
 */
export function namespaceDir(
  roots: Pick<Roots, "artifacts">,
  source: string,
  namespace: string | undefined,
): string {
  return join(registryDir(roots, source), sanitizeName(namespace ?? source));
}

/**
 * Separate from the content so that "if it is in the writable copy it is
 * pushable" stays true, and under `roots.artifacts` so a link into it is ours.
 */
export function projectionDir(
  roots: Pick<Roots, "artifacts">,
  source: string,
  namespace: string | undefined,
): string {
  return join(
    roots.artifacts,
    PROJECTIONS_DIR,
    sanitizeName(source),
    sanitizeName(namespace ?? source),
  );
}

/**
 * Keyed by what you called it rather than by version, so it is inspectable
 * without the lock and a rename shows up where you read it.
 */
export function artifactPath(
  roots: Pick<Roots, "artifacts">,
  source: string,
  namespace: string | undefined,
  kind: ArtifactKind,
  name: string,
  sourcePath: string,
): string {
  if (kind === "plugin") return namespaceDir(roots, source, name);
  return join(
    namespaceDir(roots, source, namespace),
    kindDir(kind),
    stagedLeaf(kind, name, sourcePath),
  );
}

/** A namespaced lock key (`engineering/lint`) is not a folder name. */
export function copyLeaf(localName: string, publishedName: string): string {
  return localName.includes("/") ? publishedName : localName;
}

export function stagingDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), ".staging");
}

/**
 * Where an adapter that cannot be read in place materializes bytes before they are
 * copied into a scope, keyed by the content digest they are checked against on reuse.
 */
export function stagingPath(
  content: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hex = digestHex(content ?? "");
  // A lockfile names this digest, and a repository writes lockfiles: anything else is hashed, never spelled.
  return join(stagingDir(env), "sha256", isSha256Hex(hex) ? hex : sha256Hex(content ?? ""));
}

/** Where a command acts, in a person's words. */
export function scopeName(scope: Scope): string {
  return scope === "user" ? "your user scope" : "this project";
}
