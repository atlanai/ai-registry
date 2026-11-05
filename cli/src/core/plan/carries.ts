import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { readRegular } from "#adapter/files.ts";
import type { Envelope } from "#adapter/index.ts";
import { sha256 } from "#adapter/spec/canonical.ts";
import { list } from "#adapter/text.ts";
import { isRecord } from "#core/fields.ts";
import { isDirectory } from "#core/fs/tree.ts";
import type { Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Plan } from "./model.ts";

/**
 * What a target starts on its own from a plugin it loads: commands that run as you, not
 * instructions an agent reads. Named by the plugin manifest key that declares each.
 */
export type Carried = "hooks" | "mcpServers" | "lspServers" | "monitors" | "bin";

const ORDER: readonly Carried[] = ["hooks", "mcpServers", "lspServers", "monitors", "bin"];

const WORDS: Record<Carried, string> = {
  hooks: "hooks",
  mcpServers: "MCP servers",
  lspServers: "LSP servers",
  monitors: "monitors",
  bin: "executables in bin/",
};

/** Claude Code puts a plugin's `bin/` on the agent's PATH, so what is in it runs by name. */
const BIN = "bin";

/** The default files Claude Code, Codex and the Agent Plugins layout read each from. */
const FILES: readonly [string, Carried][] = [
  ["hooks/hooks.json", "hooks"],
  [".mcp.json", "mcpServers"],
  [".lsp.json", "lspServers"],
  ["monitors/monitors.json", "monitors"],
];

const MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"];

/** What the plugin at `root` would have a target start; empty for anything that is not a folder. */
export async function carries(root: string): Promise<Carried[]> {
  const dir = await realpath(root).catch(() => undefined);
  if (dir === undefined || !(await isDirectory(dir))) return [];
  const found = new Set<Carried>();
  const verified = new Set<string>();
  for (const [path, what] of FILES) {
    const file = await readRegular(dir, path, verified);
    // A target follows a link where this read does not, so a linked file still counts.
    if (file.kind === "file" || (file.kind === "refused" && file.reason === "is a symlink")) {
      found.add(what);
    }
  }
  if (await isDirectory(join(dir, BIN))) found.add("bin");
  for (const path of MANIFESTS) {
    const file = await readRegular(dir, path, verified);
    if (file.kind !== "file") continue;
    try {
      const manifest: unknown = JSON.parse(file.bytes.toString("utf8"));
      if (isRecord(manifest)) for (const what of declared(manifest)) found.add(what);
    } catch {
      // A target refuses a manifest it cannot parse, so it starts nothing from it.
    }
  }
  return ORDER.filter((what) => found.has(what));
}

function declared(manifest: Record<string, unknown>): Carried[] {
  const experimental = isRecord(manifest.experimental) ? manifest.experimental : {};
  return ORDER.filter(
    (key) => (manifest[key] ?? (key === "monitors" ? experimental.monitors : undefined)) != null,
  );
}

/**
 * What a plugin would have a target start, read from its envelope and the manifest it is
 * placed by, before any of it is fetched; and a digest of those parts, which moves when they do.
 */
export function carriedIn(
  envelope: Envelope,
  manifest: Record<string, unknown> | undefined,
): { carries: Carried[]; fingerprint: string | undefined } {
  const found = new Set<Carried>(manifest === undefined ? [] : declared(manifest));
  const files: [string, string][] = [];
  for (const file of envelope.files) {
    const what = carrying(file.path);
    if (what === undefined) continue;
    found.add(what);
    files.push([file.path, file.digest]);
  }
  const carries = ORDER.filter((what) => found.has(what));
  if (carries.length === 0) return { carries, fingerprint: undefined };
  const declaredBy = Object.fromEntries(
    carries.flatMap((key) => (manifest?.[key] === undefined ? [] : [[key, manifest[key]]])),
  );
  const parts = { files: files.sort(), manifest: JSON.stringify(declaredBy) };
  return { carries, fingerprint: sha256(JSON.stringify(parts)) };
}

/** Whether a plugin file is one a target starts or puts on the PATH, which a fingerprint covers. */
function carrying(path: string): Carried | undefined {
  const named = FILES.find(([file]) => file === path)?.[1];
  if (named !== undefined) return named;
  if (path.startsWith(`${BIN}/`)) return "bin";
  if (path.startsWith("hooks/")) return "hooks";
  if (path.startsWith("monitors/")) return "monitors";
  return undefined;
}

export function describeCarried(carried: readonly Carried[]): string {
  return list(carried.map((what) => WORDS[what]));
}

/** Plugins this plan installs or updates that carry something a target starts on its own. */
export async function carriedBy(
  plan: Plan,
  lock: Lock | undefined,
  roots: Roots,
): Promise<{ name: string; carries: Carried[] }[]> {
  const names = new Set(
    plan.actions.flatMap((action) =>
      action.kind === "clone" || action.kind === "link" ? [action.name] : [],
    ),
  );
  const out: { name: string; carries: Carried[] }[] = [];
  for (const name of [...names].sort()) {
    const row = lock?.artifacts[name];
    if (row?.kind !== "plugin") continue;
    const what = await carries(join(roots.base, row.path));
    if (what.length > 0) out.push({ name, carries: what });
  }
  return out;
}
