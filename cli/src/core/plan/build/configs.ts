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
    const deny = want.deny;
    const denyReceipt =
      deny === undefined ? undefined : held.find((entry) => sameEntry(entry, { ...want, ...deny }));
    build.actions.push({
      kind: "configure",
      name: item.name,
      target: want.target,
      to: resolve(build.options.roots.base, want.file),
      at: want.at,
      mapping: want.mapping,
      from: copy,
      server:
        item.server === undefined
          ? undefined
          : { with: item.server.with, env: item.server.env, tools: item.server.tools },
      ...(receipt === undefined ? {} : { receipt }),
      ...(deny === undefined
        ? {}
        : {
            deny: {
              to: resolve(build.options.roots.base, deny.file),
              at: deny.at,
              items: deny.items,
              ...(denyReceipt === undefined ? {} : { receipt: denyReceipt }),
            },
          }),
      ...(build.options.force ? { force: true as const } : {}),
    });
    if (receipt !== undefined) kept.push(receipt);
    if (denyReceipt !== undefined) kept.push(denyReceipt);
  }
  for (const entry of held) {
    if (kept.includes(entry)) continue;
    // Another target still writes the same entry, such as a shared `.mcp.json`; it stays.
    const shared = wanted.some(
      (want) => want.file === entry.file && isDeepStrictEqual(want.at, entry.at),
    );
    if (!shared) unconfigure(build, item.name, entry);
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
  /** Denied tools written as items of a list in another file. */
  deny?: { file: string; at: string[]; items: string[] };
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
    const root = targetRoot(target, where);
    const user = roots.scope === "user";
    const base = mapping.anchor === "project" && !user ? roots.cwd : root;
    const path = expand(user ? (mapping.userFile ?? mapping.file) : mapping.file, vars);
    if (isAbsolute(path)) continue;
    const deny = item.server?.tools?.deny ?? [];
    wanted.push({
      target: name,
      file: posixRelative(roots.base, join(base, path)),
      at: mapping.at.map((key) => expand(key, vars)),
      mapping,
      ...(mapping.deny === undefined || deny.length === 0
        ? {}
        : {
            deny: {
              file: posixRelative(roots.base, join(root, expand(mapping.deny.file, vars))),
              at: mapping.deny.at,
              items: deny.map((tool) => expand(mapping.deny?.item ?? "", { ...vars, tool })),
            },
          }),
    });
  }
  return wanted;
}

function sameEntry(entry: LockEntry, want: Pick<Wanted, "target" | "file" | "at">): boolean {
  return (
    entry.target === want.target && entry.file === want.file && isDeepStrictEqual(entry.at, want.at)
  );
}
