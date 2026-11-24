import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, textOf } from "#adapter/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_DIR, PRIVATE_FILE } from "#core/fs/mode.ts";
import { withLease } from "#core/lease/lease.ts";
import {
  USAGE_CURSORS_FILE,
  USAGE_DIR,
  USAGE_KEY_FILE,
  USAGE_REGISTRIES_FILE,
  USAGE_RUNS_FILE,
  USAGE_SENT_FILE,
} from "#core/product.ts";
import { ensureHome, toolHome } from "#core/store/paths.ts";
import { isTime, TRIGGERS, type Trigger } from "#core/usage/model.ts";
import type { Run, SeenRegistry } from "./model.ts";

/** How far one session record has been read, and what its reader carried past that point. */
interface Cursor {
  offset: number;
  /** The file's inode, so a replacement as long as the old one is read from its start. */
  inode: number;
  state: Readonly<Record<string, string>>;
}

export type Cursors = Record<string, Cursor>;

/** Per registry: the endpoint it was sent to, and how many of its runs that endpoint has. */
export type Sent = Record<string, { otlp: string; count: number }>;

function usageDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), USAGE_DIR);
}

/** One writer at a time across the CLI and the daemon, so no run is counted or sent twice. */
export function withUsage<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  ensureHome(env);
  mkdirSync(usageDir(env), { recursive: true, mode: PRIVATE_DIR });
  return withLease(
    { scope: "user", lock: join(usageDir(env), USAGE_RUNS_FILE) },
    { wait: true, env },
    run,
  );
}

/** Every run counted on this machine, oldest first; a line that will not read is skipped. */
export async function readRuns(env: NodeJS.ProcessEnv = process.env): Promise<Run[]> {
  const text = await readText(join(usageDir(env), USAGE_RUNS_FILE));
  const runs: Run[] = [];
  for (const line of text.split("\n")) {
    const run = runOf(line);
    if (run !== undefined) runs.push(run);
  }
  return runs;
}

/** Owner-only, like everything under aireg's home that says what a person did. */
export async function appendRuns(runs: readonly Run[], env: NodeJS.ProcessEnv): Promise<void> {
  if (runs.length === 0) return;
  const lines = runs.map((run) => `${JSON.stringify(run)}\n`).join("");
  await appendFile(join(usageDir(env), USAGE_RUNS_FILE), lines, { mode: PRIVATE_FILE });
}

export async function readCursors(env: NodeJS.ProcessEnv): Promise<Cursors> {
  const read = parseJson(await readText(join(usageDir(env), USAGE_CURSORS_FILE)));
  const cursors: Cursors = {};
  if (!isRecord(read)) return cursors;
  for (const [file, value] of Object.entries(read)) {
    if (!isRecord(value) || !Number.isSafeInteger(value.offset)) continue;
    const state = isRecord(value.state) ? stringsOf(value.state) : {};
    const inode = Number.isSafeInteger(value.inode) ? (value.inode as number) : -1;
    cursors[file] = { offset: value.offset as number, inode, state };
  }
  return cursors;
}

export function writeCursors(cursors: Cursors, env: NodeJS.ProcessEnv): Promise<void> {
  // Losing it costs a reread, which the run ids make harmless, so no sync to disk.
  return writeAtomic(
    join(usageDir(env), USAGE_CURSORS_FILE),
    JSON.stringify(cursors),
    PRIVATE_FILE,
    false,
  );
}

export async function readSent(env: NodeJS.ProcessEnv): Promise<Sent> {
  const read = parseJson(await readText(join(usageDir(env), USAGE_SENT_FILE)));
  const sent: Sent = {};
  if (!isRecord(read)) return sent;
  for (const [registry, value] of Object.entries(read)) {
    const otlp = isRecord(value) ? textOf(value.otlp) : undefined;
    const count = isRecord(value) ? value.count : undefined;
    if (otlp !== undefined && Number.isSafeInteger(count))
      sent[registry] = { otlp, count: count as number };
  }
  return sent;
}

export function writeSent(sent: Sent, env: NodeJS.ProcessEnv): Promise<void> {
  return writeAtomic(
    join(usageDir(env), USAGE_SENT_FILE),
    `${JSON.stringify(sent, null, 2)}\n`,
    PRIVATE_FILE,
  );
}

export async function readRegistries(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, SeenRegistry>> {
  const read = parseJson(await readText(join(usageDir(env), USAGE_REGISTRIES_FILE)));
  const registries: Record<string, SeenRegistry> = {};
  if (!isRecord(read)) return registries;
  for (const [key, value] of Object.entries(read)) {
    if (!isRecord(value)) continue;
    const [alias, location, adapter] = [value.alias, value.location, value.adapter].map(textOf);
    if (alias === undefined || location === undefined || adapter === undefined) continue;
    const config = isRecord(value.config) ? stringsOf(value.config) : {};
    registries[key] = { key, alias, location, adapter, config };
  }
  return registries;
}

export function writeRegistries(
  registries: Record<string, SeenRegistry>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const path = join(usageDir(env), USAGE_REGISTRIES_FILE);
  return writeAtomic(path, `${JSON.stringify(registries, null, 2)}\n`, PRIVATE_FILE);
}

/** Random, made once, owner-only; a pseudonym cannot be traced back without it. */
export async function pseudonymKey(env: NodeJS.ProcessEnv): Promise<Buffer> {
  const path = join(usageDir(env), USAGE_KEY_FILE);
  const held = Buffer.from((await readText(path)).trim(), "hex");
  if (held.length === 32) return held;
  const key = randomBytes(32);
  // Written before use, so every later run names the person the same way.
  await writeAtomic(path, key.toString("hex"), PRIVATE_FILE);
  return key;
}

function runOf(line: string): Run | undefined {
  const value = parseJson(line);
  if (!isRecord(value)) return undefined;
  const [id, at, target, registry, alias, ref] = [
    value.id,
    value.at,
    value.target,
    value.registry,
    value.alias,
    value.ref,
  ].map(textOf);
  const trigger = TRIGGERS.find((item) => item === value.trigger) as Trigger | undefined;
  if (
    id === undefined ||
    !isTime(at) ||
    target === undefined ||
    registry === undefined ||
    alias === undefined ||
    ref === undefined ||
    trigger === undefined
  ) {
    return undefined;
  }
  return { id, at, target, trigger, registry, alias, ref, digest: textOf(value.digest) };
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringsOf(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
  return out;
}
