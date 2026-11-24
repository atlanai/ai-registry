import { type Dirent, readdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Target } from "#core/target/contract.ts";
import { userTargetRoot } from "#core/target/roots.ts";
import { resolveTargets } from "#core/target/table.ts";
import type { Load } from "#core/usage/model.ts";
import { readSession } from "#core/usage/sessions/read.ts";
import { Attributor } from "./attribute.ts";
import type { Run, SeenRegistry } from "./model.ts";
import {
  appendRuns,
  type Cursors,
  readCursors,
  readRegistries,
  readRuns,
  withUsage,
  writeCursors,
  writeRegistries,
} from "./store.ts";

/** A session record not yet read is read back this far, so the first count has some history. */
export const BACKFILL_DAYS = 30;
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface Collected {
  /** Runs counted by this pass, which were not counted before. */
  added: number;
  /** Every run counted on this machine. */
  runs: Run[];
  /** Every registry a counted run came from, by source key. */
  registries: Readonly<Record<string, SeenRegistry>>;
}

/**
 * Reads what each target recorded since the last pass, keeps the loads of installed versions as
 * runs, and remembers how far it read. Nothing of a conversation is kept.
 */
export function collect(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<Collected> {
  return withUsage(env, async () => {
    const cursors = await readCursors(env);
    const known = await readRuns(env);
    const ids = new Set(known.map((run) => run.id));
    const attributor = new Attributor(env);
    const added: Run[] = [];
    const seen = new Set<string>();
    for (const target of Object.values(resolveTargets(env))) {
      if (target.sessions === undefined) continue;
      for (const file of sessionFiles(join(userTargetRoot(target, env), target.sessions.path))) {
        seen.add(file);
        const loads = await readNew(file, target, cursors, now);
        for (const load of loads) {
          const run = await attributor.run(load, target.name);
          if (run === undefined || ids.has(run.id)) continue;
          ids.add(run.id);
          added.push(run);
        }
      }
    }
    await appendRuns(added, env);
    // A record that is gone needs no cursor.
    for (const file of Object.keys(cursors)) if (!seen.has(file)) delete cursors[file];
    await writeCursors(cursors, env);
    const registries = {
      ...(await readRegistries(env)),
      ...Object.fromEntries(attributor.registries),
    };
    if (attributor.registries.size > 0) await writeRegistries(registries, env);
    return { added: added.length, runs: [...known, ...added], registries };
  });
}

/** Every `.jsonl` file under `dir`, at any depth; links are not followed. */
function sessionFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sessionFiles(path);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

/** The loads in the complete lines written since the cursor; the cursor moves past them. */
async function readNew(
  file: string,
  target: Target,
  cursors: Cursors,
  now: number,
): Promise<Load[]> {
  const format = target.sessions?.format;
  if (format === undefined) return [];
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    return [];
  }
  const held = cursors[file];
  // A record nobody read and nobody touched in a month is history this machine never counted.
  if (held === undefined && now - info.mtimeMs > BACKFILL_DAYS * 86_400_000) {
    cursors[file] = { offset: info.size, inode: info.ino, state: {} };
    return [];
  }
  // Another file under the name, or shorter than where reading stopped: read from the start.
  const same = held !== undefined && held.inode === info.ino && held.offset <= info.size;
  let cursor = same ? held : { offset: 0, inode: info.ino, state: {} };
  const loads: Load[] = [];
  const handle = await open(file, "r");
  try {
    let carry = Buffer.alloc(0);
    let position = cursor.offset;
    while (position < info.size) {
      const length = Math.min(CHUNK_BYTES, info.size - position);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      // Split on newline bytes before decoding, so a character cut by the chunk stays whole.
      const bytes = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const end = bytes.lastIndexOf(0x0a);
      if (end === -1) {
        carry = bytes;
        continue;
      }
      carry = bytes.subarray(end + 1);
      const lines = bytes.subarray(0, end).toString("utf8").split("\n");
      const chunk = readSession(format, lines, cursor.state);
      loads.push(...chunk.loads);
      // Only complete lines count as read; a line still being written is read next time.
      cursor = { offset: position - carry.length, inode: info.ino, state: chunk.state };
    }
  } finally {
    await handle.close();
  }
  cursors[file] = cursor;
  return loads;
}
