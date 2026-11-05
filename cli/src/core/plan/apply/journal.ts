import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_DIR } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { present } from "#core/fs/tree.ts";
import type { Lock } from "#core/lock.ts";
import type { Plan } from "#core/plan/model.ts";
import { removal, removeContained } from "#core/plan/removable.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import type { Roots } from "#core/store/paths.ts";
import type { LinkGuard } from "./link-guard.ts";
import type { ActionOf } from "./run.ts";

interface Journal {
  /** Paths this run may have created. Recovery removes any the lock disowns. */
  writes: string[];
}

/**
 * The lock is written last, so a crash leaves the previous lock and a journal of paths that may be
 * orphaned. Each entry is read once: one that cannot be removed safely is reported and left.
 */
export async function recover(
  roots: Roots,
  lock: Lock,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Recovered> {
  const journal = await readJournal(roots.applyJournal);
  const writes = (journal?.writes ?? []).map((path) => resolve(roots.cwd, path));
  const recovered: Recovered = { removed: [], skipped: [] };
  if (writes.length === 0) return recovered;

  // Staged paths as well as links: the journal records both, so claiming only
  // links would make recovery delete the artifact's only writable copy.
  const claimed = new Set<string>();
  for (const entry of Object.values(lock.artifacts)) {
    if (entry.path !== "") claimed.add(resolve(roots.base, entry.path));
    for (const item of entry.links) claimed.add(resolve(roots.base, item.path));
  }

  for (const path of writes.filter((write) => !claimed.has(write))) {
    const verdict = removal(path, roots, env);
    const reason =
      verdict.how === "refuse"
        ? verdict.reason
        : await guardManagedPath(path, roots, false, env).then(
            () => undefined,
            (error: unknown) => (error as Error).message.replace(/\.$/, ""),
          );
    if (reason !== undefined) {
      if (await present(path)) recovered.skipped.push({ path, reason });
      continue;
    }
    await removeContained(path, roots, env);
    recovered.removed.push(path);
  }
  await rm(roots.applyJournal, { force: true });
  return recovered;
}

export interface Recovered {
  /** What a crashed run wrote that the lock does not hold, now removed. */
  removed: string[];
  /** What it wrote that was left in place, as removing it was not safe, and why. */
  skipped: { path: string; reason: string }[];
}

async function readJournal(path: string): Promise<Journal | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed)) {
      const writes = parsed.writes;
      if (Array.isArray(writes) && writes.every((item) => typeof item === "string")) {
        return { writes };
      }
    }
    throw new AiregError(`Invalid apply journal: ${path}`, { code: ErrorCode.Invalid });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function journal(
  plan: Plan,
  roots: Roots,
  guards: Map<string, LinkGuard>,
): Promise<void> {
  const writes = plan.actions
    .filter(
      (action): action is ActionOf<"stage" | "clone" | "link"> =>
        action.kind === "stage" || action.kind === "clone" || action.kind === "link",
    )
    .filter((action) => action.kind !== "link" || guards.get(action.to) !== "keep")
    .map((action) => action.to);
  if (writes.length === 0) return;
  // Owner-only, as aireg's home is, should this be the first thing written there.
  await mkdir(dirname(roots.applyJournal), { recursive: true, mode: PRIVATE_DIR });
  await writeAtomic(roots.applyJournal, JSON.stringify({ writes } satisfies Journal));
}
