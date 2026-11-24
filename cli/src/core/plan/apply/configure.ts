import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { messageOf } from "#adapter/errors.ts";
import { assertUnredirected } from "#adapter/files.ts";
import { MCP_SERVER_ENTRY } from "#adapter/kinds.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError } from "#core/errors.ts";
import { rewriteAtomic } from "#core/fs/atomic.ts";
import { isStrictlyWithin, posixRelative, readTextIfPresent } from "#core/fs/path.ts";
import { pruneEmptyParent } from "#core/fs/tree.ts";
import type { LockEntry } from "#core/lock.ts";
import type { McpEntry } from "#core/mcp/model.ts";
import { chooseOption, resolveServer } from "#core/mcp/resolve.ts";
import { mcpCodex } from "#core/target/codecs/mcp-codex.ts";
import { mcpJson } from "#core/target/codecs/mcp-json.ts";
import type { ConfigCodec, ConfigValue, ToolFilter } from "#core/target/contract.ts";
import type { ConfigDocument } from "#core/target/register/document.ts";
import { entryDigest, itemsDigest } from "#core/target/register/entry.ts";
import { openDocument } from "#core/target/register/register.ts";
import type { ActionOf, Run } from "./run.ts";

type Kept = { name: string; path: string; reason?: string; config?: true };

/** What a configure or unconfigure did: the receipt to record, and an entry left to a person. */
export interface Configured {
  receipt?: LockEntry;
  /** For denied tools written to a list beside the entry. */
  denied?: LockEntry;
  written: boolean;
  kept?: Kept;
  unrendered?: { name: string; target: string; reason: string };
}

/** Writes the target's entry, never over one a person edited or one that is not aireg's. */
export async function configure(run: Run, action: ActionOf<"configure">): Promise<Configured> {
  const { name, target, to, at, mapping, receipt } = action;
  const server = await readServer(action.from);
  const value = render(server, action);
  if (typeof value === "string") {
    return { written: false, unrendered: { name, target, reason: value }, ...keptReceipt(receipt) };
  }
  await guard(run, to);
  const doc = readable(mapping.format, await readTextIfPresent(to), to);
  if (typeof doc === "string") {
    return { written: false, unrendered: { name, target, reason: doc }, ...keptReceipt(receipt) };
  }
  const current = doc.table(at);
  const digest = digestOf(value);
  const file = posixRelative(run.inputs.roots.base, to);
  const made: LockEntry = { target, file, format: mapping.format, at, digest };
  const shared = sharedEntry(run, action, file, digest);
  if (shared !== undefined) return { written: false, ...shared };
  if (current !== undefined && digestOf(current) === digest) {
    return { written: false, receipt: made, ...(await denyList(run, action)) };
  }
  const edited =
    receipt !== undefined && current !== undefined && digestOf(current) !== receipt.digest;
  if (current !== undefined && (receipt === undefined || (edited && action.force !== true))) {
    const reason =
      receipt === undefined
        ? `${shown(at)} holds an entry aireg did not write; install it under another name with \`as\``
        : `${shown(at)} was edited after it was installed`;
    return {
      written: false,
      kept: { name, path: to, config: true, reason },
      ...keptReceipt(receipt),
    };
  }
  doc.drop(at);
  doc.set(at, value);
  await rewriteAtomic(to, doc.render());
  return { written: true, receipt: made, ...(await denyList(run, action)) };
}

/** A file aireg cannot parse, such as JSON with comments, is left whole rather than rewritten. */
function readable(
  format: ActionOf<"configure">["mapping"]["format"],
  text: string | undefined,
  to: string,
): ConfigDocument | string {
  try {
    return openDocument(format, text, {}, to);
  } catch (error) {
    if (!(error instanceof AiregError)) throw error;
    return `${basename(to)} is not plain ${format.toUpperCase()}, such as one with comments, so it was left as it is`;
  }
}

/** The first way to run the server that the target loads and its codec can write. */
function render(
  server: unknown,
  action: ActionOf<"configure">,
): Record<string, ConfigValue> | string {
  const { mapping } = action;
  const resolved = resolveServer(server, action.server ?? {});
  const chosen = chooseOption(resolved, mapping.transports);
  if (typeof chosen === "string") return chosen;
  const tools = action.server?.tools;
  // A target that denies tools in another file takes only the allow list in its entry.
  const own = mapping.deny === undefined ? tools : { allow: tools?.allow };
  let first: string | undefined;
  for (const option of resolved.options) {
    if (!mapping.transports.includes(option.entry.transport)) continue;
    const value = encode(mapping.codec, option.entry, own);
    if (typeof value !== "string") return value;
    first ??= value;
  }
  return first as string;
}

function encode(
  codec: ConfigCodec,
  entry: McpEntry,
  tools: ToolFilter | undefined,
): Record<string, ConfigValue> | string {
  switch (codec.id) {
    case "mcp-json":
      return mcpJson(entry, codec, tools);
    case "mcp-codex":
      return mcpCodex(entry, tools);
  }
}

/**
 * Two targets can read one entry, such as `.mcp.json`'s: the first this run writes it, and a
 * later one that needs it different is left out rather than overwriting it.
 */
function sharedEntry(
  run: Run,
  action: ActionOf<"configure">,
  file: string,
  digest: string,
): Pick<Configured, "receipt" | "unrendered"> | undefined {
  const key = [file, ...action.at].join("\0");
  const claimed = run.results.claims.get(key);
  if (claimed === undefined || claimed.target === action.target) {
    run.results.claims.set(key, { target: action.target, digest });
    return undefined;
  }
  const { name, target, mapping, at } = action;
  if (claimed.digest === digest) {
    return { receipt: { target, file, format: mapping.format, at, digest } };
  }
  const reason = `${file} holds the entry ${claimed.target} needs for it, which differs`;
  return { unrendered: { name, target, reason } };
}

/** Adds each denied tool to the target's list, beside any a person wrote. */
async function denyList(
  run: Run,
  action: ActionOf<"configure">,
): Promise<Pick<Configured, "denied">> {
  const { deny, target } = action;
  if (deny === undefined) return {};
  await guard(run, deny.to);
  const doc = openDocument("json", await readTextIfPresent(deny.to), {}, deny.to);
  const list = doc.list(deny.at) ?? [];
  const missing = deny.items.filter((item) => !list.includes(item));
  if (missing.length > 0) {
    doc.setList(deny.at, [...list, ...missing]);
    await rewriteAtomic(deny.to, doc.render());
  }
  const file = posixRelative(run.inputs.roots.base, deny.to);
  const digest = itemsDigest(deny.items, deny.items) as string;
  return { denied: { target, file, format: "json", at: deny.at, digest, items: deny.items } };
}

/** Takes back an entry aireg wrote, unless it was edited since. */
export async function unconfigure(run: Run, action: ActionOf<"unconfigure">): Promise<Configured> {
  const { name, to, receipt } = action;
  await guard(run, to);
  const before = await readTextIfPresent(to);
  if (before === undefined) return { written: false };
  const doc = openDocument(action.format, before, {}, to);
  if (receipt.items !== undefined) {
    const list = doc.list(receipt.at) ?? [];
    const left = list.filter((item) => !receipt.items?.includes(item as string));
    if (left.length === list.length) return { written: false };
    if (left.length === 0) dropEmpty(doc, receipt.at);
    else doc.setList(receipt.at, left);
    await settle(to, doc, run.inputs.roots.base);
    return { written: true };
  }
  const current = doc.table(receipt.at);
  if (current === undefined) return { written: false };
  if (digestOf(current) !== receipt.digest && action.force !== true) {
    const reason = `${shown(receipt.at)} was edited after it was installed, so it was left`;
    return { written: false, kept: { name, path: to, config: true, reason } };
  }
  dropEmpty(doc, receipt.at);
  await settle(to, doc, run.inputs.roots.base);
  return { written: true };
}

/** A file left empty was aireg's alone, so it goes, with the folders it leaves empty below `base`. */
async function settle(to: string, doc: ConfigDocument, base: string): Promise<void> {
  if (!isDeepStrictEqual(doc.value(), {})) return rewriteAtomic(to, doc.render());
  await rm(to, { force: true });
  if (isStrictlyWithin(base, dirname(to))) await pruneEmptyParent(to, base);
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
