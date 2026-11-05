import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type ArtifactKind, isBuiltinKind } from "#adapter/kinds.ts";
import { digestHex } from "#adapter/spec/ref.ts";
import { sanitizeName } from "#adapter/text.ts";
import { setting } from "#core/env.ts";
import { isSha256Hex, sha256Hex, shortHash } from "#core/fs/hash.ts";
import { PRIVATE_DIR } from "#core/fs/mode.ts";
import { homeDir } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { kindDir, kindSpec, stagedLeaf } from "#core/kinds.ts";
import { HOME_DIR, LEGACY_TARGETS_DIR, TARGETS_DIR } from "#core/product.ts";

export const SCOPES = ["user", "project"] as const;
export type Scope = (typeof SCOPES)[number];

/** `cwd` holds a project's target roots; `env` supplies a target's own folder variables. */
export interface Where {
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export const SCOPE_DIR = ".registry";
export const MANIFEST_FILE = "manifest.yml";
const LOCK_FILE = "manifest.lock.yml";

export interface Roots {
  scope: Scope;
  /** Relative link paths in the lock resolve against this. */
  cwd: string;
  /** Lock paths are relative to this, so the file stays portable. */
  base: string;
  manifest: string;
  lock: string;
  /** Use `namespaceDir`, `artifactPath` and `projectionDir` rather than joining onto it. */
  artifacts: string;
  /** Deleted once the lock is written. */
  applyJournal: string;
}

/** `AIREG_HOME`, else `~/.aireg`. Nothing installed lives here. */
export function toolHome(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(toolHomeRoot(env));
}

/** Like `toolHome`, but before symlinks are resolved. */
export function toolHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return setting("HOME", env) ?? join(homeDir(env), HOME_DIR);
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "state");
}

/** Under the project's `.registry/`, or for the user scope under the home. */
export const LEASES_DIR = "leases";

/**
 * Owner-only whatever the umask: credentials are refused under a home others can write to.
 * An existing home keeps its mode.
 */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = toolHome(env);
  mkdirSync(home, { recursive: true, mode: PRIVATE_DIR });
  return home;
}

/** `AIREG_USER_SCOPE`, else `~/.registry`; never derived from `AIREG_HOME`. */
export function userScopeDir(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(setting("USER_SCOPE", env) ?? join(homeDir(env), SCOPE_DIR));
}

/** Tokens aireg stores itself, owner-only and apart from `config.yml`. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "credentials.json");
}

export function adaptersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "adapters");
}

export function targetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), TARGETS_DIR);
}

/** Where aireg 0.1 kept target definitions; still read beside `targetsDir`. */
export function legacyTargetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), LEGACY_TARGETS_DIR);
}

/** Beside the version directories: unpin deletes those, and this must survive a swap. */
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

/** Outside the user scope's tree so leases survive that tree being replaced. */
export function leasesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), LEASES_DIR);
}

export function roots(scope: Scope, cwd: string, env: NodeJS.ProcessEnv = process.env): Roots {
  const user = scope === "user";
  const dir = user ? userScopeDir(env) : join(cwd, SCOPE_DIR);
  // Canonical like the scope folder, or under a symlinked home lock paths escape upwards.
  return {
    scope,
    cwd,
    base: user ? homeDir(env) : cwd,
    manifest: join(dir, MANIFEST_FILE),
    lock: join(dir, LOCK_FILE),
    artifacts: join(dir, "artifacts"),
    applyJournal: journalPath(dir, env),
  };
}

/** In aireg's home, not the scope: recovery deletes what it names, and a clone could ship one. */
function journalPath(dir: string, env: NodeJS.ProcessEnv): string {
  const scope = join(canonical(dirname(dir)), basename(dir));
  const key = shortHash(scope);
  return join(toolHome(env), "journals", `${key}.json`);
}

/** Positional, not declared: the user scope's folder, else a project. */
export function scopeFor(root: string, env: NodeJS.ProcessEnv = process.env): Scope {
  return resolve(canonical(root)) === userScopeDir(env) ? "user" : "project";
}

/** One clone per repository so fetches are incremental. Deleting it only costs a refetch. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "cache");
}

/** Dot-prefixed so it cannot collide with a registry alias, which `sanitizeName` never dots. */
export const PROJECTIONS_DIR = ".projections";

/** Kinds adapters declare, kept out of every namespace folder, which a target may load as a plugin. */
const DECLARED_KINDS_DIR = ".kinds";

export function registryDir(roots: Pick<Roots, "artifacts">, source: string): string {
  return join(roots.artifacts, sanitizeName(source));
}

/** Content only: manifests, generated files and packaging live in the projection beside it. */
export function namespaceDir(
  roots: Pick<Roots, "artifacts">,
  source: string,
  namespace: string | undefined,
): string {
  return join(registryDir(roots, source), sanitizeName(namespace ?? source));
}

/**
 * Apart from content so everything in the writable copy stays pushable, and under
 * `roots.artifacts` so a link into it is ours.
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

/** Keyed by local name, not version, so it is inspectable without the lock. */
export function artifactPath(
  roots: Pick<Roots, "artifacts">,
  source: string,
  namespace: string | undefined,
  kind: ArtifactKind,
  name: string,
  sourcePath: string,
): string {
  if (kind === "plugin") return namespaceDir(roots, source, name);
  if (!isBuiltinKind(kind)) {
    const at = join(
      roots.artifacts,
      DECLARED_KINDS_DIR,
      sanitizeName(source),
      kind,
      sanitizeName(namespace ?? source),
    );
    // Nothing installs a kind no loaded adapter declares, so this only names a place to look.
    return join(at, kindSpec(kind) === undefined ? name : stagedLeaf(kind, name, sourcePath));
  }
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

/** For adapters that cannot be read in place; keyed by the digest rechecked on reuse. */
export function stagingPath(
  content: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hex = digestHex(content ?? "");
  // Lockfiles come from repositories: anything but a real digest is hashed, never used as a path.
  return join(stagingDir(env), "sha256", isSha256Hex(hex) ? hex : sha256Hex(content ?? ""));
}

export function scopeName(scope: Scope): string {
  return scope === "user" ? "your user scope" : "this project";
}

/** Includes its leading space. */
export function scopeFlag(scope: Scope): string {
  return scope === "user" ? " -g" : "";
}
