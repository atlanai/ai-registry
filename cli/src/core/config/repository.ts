import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { withLease } from "#core/lease/lease.ts";
import { ensureHome, toolHome } from "#core/store/paths.ts";
import { ConfigConflictError } from "./errors.ts";
import { emptyRegistryConfig, type RegistryConfig } from "./model.ts";
import { formatConfig, parseConfig } from "./parse.ts";

const CONFIG_FILENAME = "config.yml";
let pendingWrite: Promise<unknown> = Promise.resolve();

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), CONFIG_FILENAME);
}

export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<RegistryConfig> {
  const path = configPath(env);
  try {
    return parseConfig(await readFile(path, "utf8"), path);
  } catch (cause) {
    if (isMissing(cause)) return emptyRegistryConfig();
    throw cause;
  }
}

/** An edit applied to whatever is current, for a writer that changes only what it names. */
export function updateConfig(
  edit: (current: RegistryConfig) => RegistryConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryConfig> {
  const write = pendingWrite.then(() =>
    underLease(env, async () => {
      const current = await readConfig(env);
      const updated = parseConfig(
        formatConfig({ ...edit(current), revision: current.revision + 1 }),
        configPath(env),
      );
      await writeAtomic(configPath(env), formatConfig(updated), PRIVATE_FILE);
      return updated;
    }),
  );
  // The caller sees this write's failure; the queue only orders the next one after it.
  pendingWrite = write.catch(() => {});
  return write;
}

/** The revision check and the write are one step across processes, so no writer silently undoes another. */
function underLease<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  ensureHome(env);
  return withLease({ scope: "user", lock: configPath(env) }, { wait: true, env }, run);
}

/** A whole config written over the revision it was read at, refused if another writer moved it on. */
export function writeConfig(
  next: RegistryConfig,
  expectedRevision: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryConfig> {
  return updateConfig((current) => {
    if (current.revision !== expectedRevision) throw new ConfigConflictError(current.revision);
    return next;
  }, env);
}
