import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homeDir } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { type Lock, type LockArtifact, readLock } from "#core/lock.ts";
import { type Roots, roots } from "#core/store/paths.ts";
import type { Load } from "#core/usage/model.ts";
import type { Run, SeenRegistry } from "./model.ts";

interface Installed {
  row: LockArtifact;
  registry: SeenRegistry;
}

/**
 * Finds the installed version behind each load: a lockfile row whose copy or link sits at the
 * folder the session read. The user scope's lockfile is read once, and a project's the first time
 * a session ran inside it.
 */
export class Attributor {
  readonly #env: NodeJS.ProcessEnv;
  readonly #byPath = new Map<string, Installed>();
  readonly #projects = new Map<string, Promise<void>>();
  readonly #registries = new Map<string, SeenRegistry>();
  #user: Promise<void> | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  /** Every registry a run so far came from, by source key. */
  get registries(): ReadonlyMap<string, SeenRegistry> {
    return this.#registries;
  }

  /** Undefined for a load of something no lockfile installed, such as a skill you wrote. */
  async run(load: Load, target: string): Promise<Run | undefined> {
    this.#user ??= this.#index(roots("user", homeDir(this.#env), this.#env));
    await this.#user;
    const project = load.cwd === undefined ? undefined : projectOf(load.cwd, this.#env);
    if (project !== undefined) {
      let indexed = this.#projects.get(project);
      if (indexed === undefined) {
        indexed = this.#index(roots("project", project, this.#env));
        this.#projects.set(project, indexed);
      }
      await indexed;
    }
    const found = this.#byPath.get(resolve(load.path)) ?? this.#byPath.get(canonical(load.path));
    if (found === undefined) return undefined;
    const { row, registry } = found;
    if (row.namespace === undefined || row.version === undefined) return undefined;
    const ref = `${row.namespace}/${row.kind}/${row.name}@${row.version}`;
    this.#registries.set(registry.key, registry);
    return {
      id: runId(target, load, registry.key, ref),
      at: load.at,
      target,
      trigger: load.trigger,
      registry: registry.key,
      alias: registry.alias,
      ref,
      digest: row.content,
    };
  }

  async #index(scope: Roots): Promise<void> {
    let lock: Lock;
    try {
      lock = await readLock(scope);
    } catch {
      // A lockfile that will not read installs nothing this can name; its runs go uncounted.
      return;
    }
    for (const row of Object.values(lock.artifacts)) {
      const held = lock.registries[row.registry];
      if (held === undefined) continue;
      const installed: Installed = {
        row,
        registry: {
          key: held.key,
          alias: row.registry,
          location: held.location,
          adapter: held.adapter,
          config: held.config,
        },
      };
      const paths = [row.path, ...row.links.map((link) => link.path)].filter((path) => path !== "");
      for (const path of paths) {
        const absolute = join(scope.base, path);
        // A later scope's row wins: a project's install is the one its sessions load.
        this.#byPath.set(resolve(absolute), installed);
        this.#byPath.set(canonical(absolute), installed);
      }
    }
  }
}

/** The nearest folder at or above `cwd` with a lockfile, which is the project a session ran in. */
function projectOf(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = resolve(homeDir(env));
  let at = resolve(cwd);
  for (;;) {
    // Home's own `.registry` is the user scope, read already.
    if (at === home) return undefined;
    if (existsSync(roots("project", at, env).lock)) return at;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** A one-way hash, so the id reveals neither the session nor the folder. */
function runId(target: string, load: Load, registry: string, ref: string): string {
  return createHash("sha256")
    .update([target, load.session, load.turn, registry, ref].join("\0"))
    .digest("hex")
    .slice(0, 32);
}
