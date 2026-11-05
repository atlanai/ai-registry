import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { PUBLIC_FILE } from "#adapter/files.ts";
import { isWithin } from "#adapter/paths.ts";
import { inspectAdapterModule, isBuiltinAdapter } from "#core/adapter/load.ts";
import { updateConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { ADAPTER_MODULE_FILE } from "#core/product.ts";
import { adapterDataDir, adapterModulePath, ensureHome, toolHome } from "#core/store/paths.ts";
import { parseDispatch, writeInstallRecord } from "./record.ts";

export function adapterSpecifier(id: string, version: string): string {
  return `./adapters/${id}/${version}/${ADAPTER_MODULE_FILE}`;
}

export async function writeInstalled(
  id: string,
  version: string,
  bytes: Uint8Array,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (isBuiltinAdapter(id)) {
    throw new AiregError(`${id} is built into aireg, so it cannot be installed.`, {
      code: ErrorCode.Usage,
    });
  }
  const path = adapterModulePath(id, version, ADAPTER_MODULE_FILE, env);
  ensureHome(env);
  await writeAtomic(path, bytes, PUBLIC_FILE);
  try {
    const adapter = await inspectAdapterModule(path, id);
    const dispatch = parseDispatch(adapter.dispatch);
    if (dispatch === undefined) {
      throw new AiregError(`Adapter ${id} does not say which registry addresses it reads.`, {
        code: ErrorCode.Invalid,
      });
    }
    await writeInstallRecord(path, {
      id,
      sha256: sha256Hex(bytes),
      protocol: adapter.protocol,
      dispatch,
    });
    const specifier = adapterSpecifier(id, version);
    await pinAdapter(id, specifier, env);
    return specifier;
  } catch (error) {
    await rm(dirname(path), { recursive: true, force: true });
    throw error;
  }
}

async function pinAdapter(
  id: string,
  specifier: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let replaced: string | undefined;
  await mutateAdapters((adapters) => {
    replaced = adapters[id];
    return { ...adapters, [id]: specifier };
  }, env);
  // Nothing loads the version this replaces, so it goes.
  if (replaced !== undefined && replaced !== specifier) {
    await removeManaged(id, replaced, env).catch(() => undefined);
  }
}

async function mutateAdapters(
  next: (adapters: Readonly<Record<string, string>>) => Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await updateConfig((current) => ({ ...current, adapters: next(current.adapters) }), env);
}

/** Only a `<version>/<module>` path under this adapter's folder is aireg's to delete. */
async function removeManaged(id: string, specifier: string, env: NodeJS.ProcessEnv): Promise<void> {
  const resolved = isAbsolute(specifier) ? specifier : join(toolHome(env), specifier);
  const dir = adapterDataDir(id, env);
  if (!isWithin(dir, resolved) || relative(dir, resolved).split(sep).length !== 2) return;
  await rm(dirname(resolved), { recursive: true, force: true });
}

export async function unpinAdapter(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let removed: string | undefined;
  await mutateAdapters((adapters) => {
    removed = adapters[id];
    const rest = { ...adapters };
    delete rest[id];
    return rest;
  }, env);
  if (removed !== undefined) await removeVersions(id, env);
  return removed;
}

/** Every version folder aireg installed for this adapter; its data beside them stays. */
async function removeVersions(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = adapterDataDir(id, env);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !existsSync(join(dir, entry.name, ADAPTER_MODULE_FILE))) continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
  }
}
