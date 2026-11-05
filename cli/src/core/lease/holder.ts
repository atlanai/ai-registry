import { readFile } from "node:fs/promises";
import { isRecord } from "#core/fields.ts";
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
  try {
    return parseHolder(JSON.parse(await readFile(metaPath(dir), "utf8")));
  } catch {
    return undefined;
  }
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
