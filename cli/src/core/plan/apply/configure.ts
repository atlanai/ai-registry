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
import { runLine } from "#core/mcp/describe.ts";
import type { McpEntry } from "#core/mcp/model.ts";
import { chooseOption, resolveServer } from "#core/mcp/resolve.ts";
import type { Action } from "#core/plan/model.ts";
import { mcpCodex } from "#core/target/codecs/mcp-codex.ts";
import { mcpJson } from "#core/target/codecs/mcp-json.ts";
import type { ConfigCodec, ConfigValue, ToolFilter } from "#core/target/contract.ts";
import type { ConfigDocument } from "#core/target/register/document.ts";
import { entryDigest, itemsDigest } from "#core/target/register/entry.ts";
import { openDocument } from "#core/target/register/register.ts";
import type { ActionOf, Kept, Run, Unrendered } from "./run.ts";

/** What a configure or unconfigure did: the receipt to record, and an entry left to a person. */
export interface Configured {
  receipt?: LockEntry;
  /** For denied tools written to a list beside the entry. */
  denied?: LockEntry;
  written: boolean;
  kept?: Kept;
  unrendered?: Unrendered;
}

/** Writes the target's entry, never over one a person edited or one that is not aireg's. */
export async function configure(run: Run, action: ActionOf<"configure">): Promise<Configured> {
  const { name, target, to, at, mapping, receipt } = action;
  const server = await readServer(action.from);
  const value = render(server, action);
  if (typeof value === "string") return leaveOut(run, action, { name, target, reason: value });
  const shared = await leftOutOfShared(run, action);
  if (shared !== undefined) return leaveOut(run, action, shared);
  await guard(run, to);
  const doc = readable(mapping.format, await readTextIfPresent(to), to);
  if (typeof doc === "string") {
    return { written: false, unrendered: { name, target, reason: doc }, ...keptReceipt(receipt) };
  }
  const current = doc.table(at);
  const digest = digestOf(value);
  const file = posixRelative(run.inputs.roots.base, to);
  const runs = runOf(server, action);
  const made: LockEntry = {
    target,
    file,
    format: mapping.format,
    at,
    digest,
    ...(runs === undefined ? {} : { runs: runsDigest(runs) }),
  };
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
  try {
    doc.drop(at);
    doc.set(at, value);
  } catch (error) {
    // Such as an inline TOML table holding the entry: the person's, so only this target skips.
    if (!(error instanceof AiregError)) throw error;
    const reason = `${shown(at)} holds an entry aireg did not write; install it under another name with \`as\``;
    return {
      written: false,
      kept: { name, path: to, config: true, reason },
      ...keptReceipt(receipt),
    };
  }
  await rewriteAtomic(to, doc.render());
  return { written: true, receipt: made, ...(await denyList(run, action)) };
}

/** What the entry would start, when that differs from what aireg wrote there before. */
export async function newRun(
  action: ActionOf<"configure">,
  dir: string,
): Promise<string | undefined> {
  const run = runOf(await readServer(dir), action);
  if (run === undefined || action.receipt?.runs === runsDigest(run)) return undefined;
  return run;
}

function runOf(server: unknown, action: ActionOf<"configure">): string | undefined {
  const chosen = chooseOption(
    resolveServer(server, action.server ?? {}),
    action.mapping.transports,
  );
  if (typeof chosen === "string" || typeof render(server, action) === "string") return undefined;
  return runLine(chosen.entry);
}

const runsDigest = (run: string): string => entryDigest({ run });

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

/** Groups the entries several targets read, settled once their content is staged. */
export function shareEntries(run: Run, actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.kind !== "configure") continue;
    const key = entryKey(action);
    const held = run.results.shared.get(key);
    if (held === undefined) run.results.shared.set(key, { group: [action] });
    else held.group.push(action);
  }
}

const cannot = ({ filtered }: { filtered: boolean }): string =>
  filtered ? "cannot apply its tool filter" : "cannot install it";

const entryKey = (action: ActionOf<"configure">): string => [action.to, ...action.at].join("\0");

/**
 * Targets that read one entry, such as `.mcp.json`'s, get it only when each writes it the same:
 * otherwise one would load the server without the tool filter another needs.
 */
async function leftOutOfShared(
  run: Run,
  action: ActionOf<"configure">,
): Promise<Unrendered | undefined> {
  const held = run.results.shared.get(entryKey(action));
  if (held === undefined) return undefined;
  held.out ??= await settleShared(run, held.group);
  return held.out.get(action.target);
}

async function settleShared(
  run: Run,
  group: readonly ActionOf<"configure">[],
): Promise<Map<string, Unrendered>> {
  const out = new Map<string, Unrendered>();
  if (new Set(group.map((action) => action.target)).size < 2) return out;
  const rendered = await Promise.all(
    group.map(async (action) => {
      const server = await readServer(action.from);
      const value = render(server, action);
      const unfiltered = { ...action, server: { ...action.server, tools: undefined } };
      const filtered = typeof value === "string" && typeof render(server, unfiltered) !== "string";
      return { action, digest: typeof value === "string" ? undefined : digestOf(value), filtered };
    }),
  );
  for (const { action, digest } of rendered) {
    if (digest === undefined) continue;
    const other = rendered.find((them) => them.digest !== digest);
    if (other === undefined) continue;
    const reason = other.digest !== undefined ? "needs a different entry for it" : cannot(other);
    const file = posixRelative(run.inputs.roots.base, action.to);
    out.set(action.target, {
      name: action.name,
      target: action.target,
      reason,
      shared: { file, with: other.action.target },
    });
  }
  return out;
}

/** A target left out loses the entry aireg wrote for it, so a stale one never loads unfiltered. */
async function leaveOut(
  run: Run,
  action: ActionOf<"configure">,
  unrendered: Unrendered,
): Promise<Configured> {
  const { name, target, to, mapping, receipt, deny } = action;
  const force = action.force === true ? { force: true as const } : {};
  const take = { kind: "unconfigure" as const, name, target, ...force };
  let kept: Configured["kept"];
  try {
    if (receipt !== undefined) {
      ({ kept } = await unconfigure(run, { ...take, to, format: mapping.format, receipt }));
    }
    if (deny?.receipt !== undefined) {
      await unconfigure(run, { ...take, to: deny.to, format: "json", receipt: deny.receipt });
    }
  } catch (error) {
    if (!(error instanceof AiregError)) throw error;
    return { written: false, unrendered, ...keptReceipt(receipt) };
  }
  return { written: false, unrendered, ...(kept === undefined ? {} : { kept }) };
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
  // A rule the person already had stays theirs, so remove never takes it.
  const ours = deny.items.filter(
    (item) => missing.includes(item) || deny.receipt?.items?.includes(item) === true,
  );
  if (ours.length === 0) return {};
  const file = posixRelative(run.inputs.roots.base, deny.to);
  const digest = itemsDigest(ours, ours) as string;
  return { denied: { target, file, format: "json", at: deny.at, digest, items: ours } };
}

/** Whether the entry beside these deny rules was edited, so remove leaves it, whatever runs first. */
export async function entryStays(run: Run, action: ActionOf<"unconfigure">): Promise<boolean> {
  if (action.force === true) return false;
  const entries = run.inputs.before?.artifacts[action.name]?.entries ?? [];
  const entry = entries.find((one) => one.target === action.target && one.items === undefined);
  if (entry === undefined) return false;
  const to = join(run.inputs.roots.base, entry.file);
  const doc = readable(entry.format, await readTextIfPresent(to), to);
  const current = typeof doc === "string" ? undefined : doc.table(entry.at);
  return current !== undefined && digestOf(current) !== entry.digest;
}

/** Takes back an entry aireg wrote, unless it was edited since. */
export async function unconfigure(run: Run, action: ActionOf<"unconfigure">): Promise<Configured> {
  const { name, to, receipt } = action;
  await guard(run, to);
  const before = await readTextIfPresent(to);
  if (before === undefined) return { written: false };
  const doc = readable(action.format, before, to);
  if (typeof doc === "string")
    return { written: false, kept: { name, path: to, config: true, reason: doc } };
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
