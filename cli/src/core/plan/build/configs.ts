import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { posixRelative } from "#core/fs/path.ts";
import type { LockArtifact, LockEntry } from "#core/lock.ts";
import type { Action, Selected } from "#core/plan/model.ts";
import type { KindMapping } from "#core/target/contract.ts";
import { targetRoot } from "#core/target/roots.ts";
import { expand } from "#core/target/template.ts";
import type { BuildState } from "./state.ts";

type ConfigMapping = Extract<KindMapping, { shape: "config" }>;

/**
 * Plans an entry in each target's config for an MCP server, and takes back the ones its targets
 * no longer want; returns the receipts this run keeps, which apply brings up to date.
 */
export function planConfigs(
  item: Selected,
  copy: string,
  previous: LockArtifact | undefined,
  build: BuildState,
): LockEntry[] {
  const held = previous?.entries ?? [];
  const wanted = item.kind === "mcp_server" ? configsFor(item, build) : [];
  const kept: LockEntry[] = [];
  for (const want of wanted) {
    const receipt = held.find((entry) => sameEntry(entry, want));
    build.actions.push({
      kind: "configure",
      name: item.name,
      target: want.target,
      to: resolve(build.options.roots.base, want.file),
      at: want.at,
      mapping: want.mapping,
      from: copy,
      server:
        item.server === undefined ? undefined : { with: item.server.with, env: item.server.env },
      ...(receipt === undefined ? {} : { receipt }),
      ...(build.options.force ? { force: true as const } : {}),
    });
    if (receipt !== undefined) kept.push(receipt);
  }
  for (const entry of held) {
    if (!wanted.some((want) => sameEntry(entry, want))) unconfigure(build, item.name, entry);
  }
  if (item.server?.tools !== undefined && wanted.length > 0) {
    build.warnings.push({
      name: item.name,
      message: `No target here can narrow an MCP server's tools, so \`tools\` of ${item.name} is not applied.`,
    });
  }
  return kept;
}

export function unconfigure(build: BuildState, name: string, receipt: LockEntry): void {
  const action: Extract<Action, { kind: "unconfigure" }> = {
    kind: "unconfigure",
    name,
    target: receipt.target,
    to: resolve(build.options.roots.base, receipt.file),
    format: receipt.format,
    receipt,
    ...(build.options.force ? { force: true as const } : {}),
  };
  build.actions.push(action);
}

interface Wanted {
  target: string;
  /** Relative to the scope base, as the lockfile records it. */
  file: string;
  at: string[];
  mapping: ConfigMapping;
}

function configsFor(item: Selected, build: BuildState): Wanted[] {
  const { roots, env, targets, targetTable } = build.options;
  const where = { scope: roots.scope, cwd: roots.cwd, env };
  const chosen =
    item.targets === undefined ? targets : targets.filter((t) => item.targets?.includes(t));
  const wanted: Wanted[] = [];
  for (const name of chosen) {
    const target = targetTable[name];
    const mapping = target?.kinds.mcp_server;
    if (target === undefined || mapping?.shape !== "config") continue;
    if (mapping.scope !== undefined && mapping.scope !== roots.scope) continue;
    const vars = { name: item.name };
    const base = mapping.anchor === "project" ? roots.cwd : targetRoot(target, where);
    const path = expand(mapping.file, vars);
    if (isAbsolute(path)) continue;
    wanted.push({
      target: name,
      file: posixRelative(roots.base, join(base, path)),
      at: mapping.at.map((key) => expand(key, vars)),
      mapping,
    });
  }
  return wanted;
}

function sameEntry(entry: LockEntry, want: Wanted): boolean {
  return (
    entry.target === want.target && entry.file === want.file && isDeepStrictEqual(entry.at, want.at)
  );
}
