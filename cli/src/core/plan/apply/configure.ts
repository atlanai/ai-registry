import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { messageOf } from "#adapter/errors.ts";
import { assertUnredirected } from "#adapter/files.ts";
import { MCP_SERVER_ENTRY } from "#adapter/kinds.ts";
import { quoted } from "#adapter/text.ts";
import { rewriteAtomic } from "#core/fs/atomic.ts";
import { posixRelative, readTextIfPresent } from "#core/fs/path.ts";
import type { LockEntry } from "#core/lock.ts";
import { chooseOption, resolveServer } from "#core/mcp/resolve.ts";
import { mcpJson } from "#core/target/codecs/mcp-json.ts";
import type { ConfigDocument } from "#core/target/register/document.ts";
import { entryDigest } from "#core/target/register/entry.ts";
import { openDocument } from "#core/target/register/register.ts";
import type { ActionOf, Run } from "./run.ts";

type Kept = { name: string; path: string; reason?: string; config?: true };

/** What a configure or unconfigure did: the receipt to record, and an entry left to a person. */
export interface Configured {
  receipt?: LockEntry;
  written: boolean;
  kept?: Kept;
  unrendered?: { name: string; target: string; reason: string };
}

/** Writes the target's entry, never over one a person edited or one that is not aireg's. */
export async function configure(run: Run, action: ActionOf<"configure">): Promise<Configured> {
  const { name, target, to, at, mapping, receipt } = action;
  const server = await readServer(action.from);
  const chosen = chooseOption(resolveServer(server, action.server ?? {}), mapping.transports);
  if (typeof chosen === "string") {
    return {
      written: false,
      unrendered: { name, target, reason: chosen },
      ...keptReceipt(receipt),
    };
  }
  const value = mcpJson(chosen.entry, mapping.codec.secret);
  await guard(run, to);
  const doc = openDocument(mapping.format, await readTextIfPresent(to), {}, to);
  const current = doc.table(at);
  const digest = digestOf(value);
  const made: LockEntry = {
    target,
    file: posixRelative(run.inputs.roots.base, to),
    format: mapping.format,
    at,
    digest,
  };
  if (current !== undefined && digestOf(current) === digest)
    return { written: false, receipt: made };
  const edited =
    receipt !== undefined && current !== undefined && digestOf(current) !== receipt.digest;
  if (current !== undefined && (receipt === undefined || (edited && action.force !== true))) {
    const kept: Kept =
      receipt === undefined
        ? {
            name,
            path: to,
            config: true,
            reason: `${shown(at)} holds an entry aireg did not write; install it under another name with \`as\``,
          }
        : {
            name,
            path: to,
            config: true,
            reason: `${shown(at)} was edited after it was installed`,
          };
    return { written: false, kept, ...keptReceipt(receipt) };
  }
  doc.drop(at);
  doc.set(at, value);
  await rewriteAtomic(to, doc.render());
  return { written: true, receipt: made };
}

/** Takes back an entry aireg wrote, unless it was edited since. */
export async function unconfigure(run: Run, action: ActionOf<"unconfigure">): Promise<Configured> {
  const { name, to, receipt } = action;
  await guard(run, to);
  const before = await readTextIfPresent(to);
  if (before === undefined) return { written: false };
  const doc = openDocument(action.format, before, {}, to);
  const current = doc.table(receipt.at);
  if (current === undefined) return { written: false };
  if (digestOf(current) !== receipt.digest && action.force !== true) {
    const reason = `${shown(receipt.at)} was edited after it was installed, so it was left`;
    return { written: false, kept: { name, path: to, config: true, reason } };
  }
  dropEmpty(doc, receipt.at);
  if (isDeepStrictEqual(doc.value(), {})) await rm(to, { force: true });
  else await rewriteAtomic(to, doc.render());
  return { written: true };
}

async function readServer(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, MCP_SERVER_ENTRY), "utf8")) as unknown;
  } catch (error) {
    return { problem: messageOf(error) };
  }
}

/** A project's config is reached through real folders, as every file aireg writes there is. */
async function guard(run: Run, to: string): Promise<void> {
  const { roots } = run.inputs;
  if (roots.scope === "project") await assertUnredirected(roots.cwd, to);
}

function keptReceipt(receipt: LockEntry | undefined): Pick<Configured, "receipt"> {
  return receipt === undefined ? {} : { receipt };
}

function dropEmpty(doc: ConfigDocument, at: readonly string[]): void {
  doc.drop(at);
  for (let depth = at.length - 1; depth > 0; depth--) {
    const parent = at.slice(0, depth);
    const table = doc.table(parent);
    if (table === undefined || Object.keys(table).length > 0) break;
    doc.drop(parent);
  }
}

const digestOf = (value: Readonly<Record<string, unknown>>): string => entryDigest(value);

function shown(at: readonly string[]): string {
  return quoted(at.join("."));
}
