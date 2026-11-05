import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isRecord } from "#adapter/fields.ts";
import { ifPresent, isAbsent } from "#adapter/files.ts";
import { metaPath } from "./location.ts";

export interface LeaseHolder {
  id: string;
  scope: string;
  lock: string;
  host: string;
  pid: number;
  acquiredAtMs: number;
}

export async function readHolder(dir: string): Promise<LeaseHolder | undefined> {
  return holderOf(await ifPresent(readFile(metaPath(dir), "utf8")));
}

/** For a signal handler, which cannot wait for a read. */
export function readHolderSync(dir: string): LeaseHolder | undefined {
  let text: string;
  try {
    text = readFileSync(metaPath(dir), "utf8");
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
  return holderOf(text);
}

function holderOf(text: string | undefined): LeaseHolder | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Written by a claim not yet finished, so there is no holder to read yet.
    return undefined;
  }
  return parseHolder(value);
}

/**
 * Any process that can write the home can write this file, so a holder whose fields are off
 * is no holder: a pid such as -1 or 0 names a process group, which would always look alive.
 */
function parseHolder(value: unknown): LeaseHolder | undefined {
  if (!isRecord(value)) return undefined;
  const { id, scope, lock, host, pid, acquiredAtMs } = value;
  if (typeof id !== "string" || typeof scope !== "string" || typeof lock !== "string") {
    return undefined;
  }
  if (typeof host !== "string" || typeof acquiredAtMs !== "number") return undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { id, scope, lock, host, pid, acquiredAtMs };
}
