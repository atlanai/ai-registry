import { readFile } from "node:fs/promises";
import { writeAtomic } from "#core/fs/atomic.ts";
import { updateCheckPath } from "#core/release/layout.ts";
import { ensureHome } from "#core/store/paths.ts";
import { downloadSize, type ResolvedRelease } from "./release.ts";

export interface UpdateCache {
  /** When the channel was last asked, answered or not, so a dead origin costs one try per interval. */
  checkedAt: number;
  latest?: string | undefined;
  /** The signed artifact size, so the hint can say what the update costs. */
  sizeBytes?: number | undefined;
  minimumVersion?: string | undefined;
}

export function cacheFrom(release: ResolvedRelease, now = Date.now()): UpdateCache {
  return {
    checkedAt: now,
    latest: release.version,
    sizeBytes: downloadSize(release),
    minimumVersion: release.minimumVersion,
  };
}

export async function readUpdateCache(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(updateCheckPath(env), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const doc = raw as Record<string, unknown>;
    if (typeof doc.checkedAt !== "number") return undefined;
    return {
      checkedAt: doc.checkedAt,
      latest: typeof doc.latest === "string" ? doc.latest : undefined,
      sizeBytes: typeof doc.sizeBytes === "number" ? doc.sizeBytes : undefined,
      minimumVersion: typeof doc.minimumVersion === "string" ? doc.minimumVersion : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function writeUpdateCache(
  cache: UpdateCache,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  ensureHome(env);
  await writeAtomic(updateCheckPath(env), `${JSON.stringify(cache)}\n`);
}
