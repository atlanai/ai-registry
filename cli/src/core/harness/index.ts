import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { onPath } from "#adapter/paths.ts";
import { sanitizeName } from "#adapter/text.ts";
import { present } from "#core/env.ts";
import { expandUserPath } from "#core/fs/path.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { Scope } from "#core/store/paths.ts";
import { BUILTIN_HARNESSES } from "#harnesses/index.ts";
import type { HarnessDefinition, Harnesses, Target } from "./contract.ts";

export type { Harnesses, KindMapping, Target } from "./contract.ts";

/** The tools a manifest installs into when it names none, in the order they are listed. */
export const DEFAULT_TARGETS: readonly string[] = BUILTIN_HARNESSES.filter(
  (harness) => harness.default === true,
).map((harness) => harness.id);

/** The harnesses whose folders hold artifacts worth importing, by name. */
export const IMPORTABLE_HARNESSES: readonly string[] = BUILTIN_HARNESSES.filter(
  (harness) => harness.importable === true,
)
  .map((harness) => harness.id)
  .sort();

/** Variables that name the harness running this process, in the order they are checked. */
export const CALLER_SIGNALS: readonly { agent: string; env: readonly string[] }[] =
  BUILTIN_HARNESSES.flatMap((harness) =>
    harness.detect === "never" || harness.detect?.caller === undefined
      ? []
      : [{ agent: harness.id, env: harness.detect.caller }],
  );

function definition(name: string): HarnessDefinition | undefined {
  return BUILTIN_HARNESSES.find((harness) => harness.id === name);
}

/** The runtime a registry agent written for this harness names, when it has one. */
export function agentRuntimeOf(name: string): string | undefined {
  return definition(name)?.runtime;
}

/** The built-in harnesses, the only ones aireg knows, as data that crosses the daemon RPC. */
export function resolveHarnesses(env: NodeJS.ProcessEnv = process.env): Harnesses {
  const out: Harnesses = {};
  for (const input of BUILTIN_HARNESSES) {
    const detect = input.detect ?? {};
    out[input.id] = {
      name: input.id,
      displayName: input.displayName,
      projectRoot: input.roots.project,
      userRoot: expandUserPath(input.roots.user.default, env),
      envHome: input.roots.user.env,
      detect:
        detect === "never"
          ? "never"
          : { env: detect.env ?? [], binary: detect.binary ?? [], paths: detect.paths ?? [] },
      kinds: structuredClone(input.kinds),
      reads: { ...input.reads },
      shared: input.shared ?? false,
    };
  }
  return out;
}

export function names(harnesses: Harnesses): string[] {
  return Object.keys(harnesses).sort();
}

/** The folders a harness reads a kind from, most preferred first. */
export function readsFor(harnesses: Harnesses, name: string, kind: ArtifactKind): string[] {
  const target = harnesses[name];
  if (target === undefined) return [];
  return target.reads[kind] ?? (target.kinds[kind] === undefined ? [] : [name]);
}

function placeable(target: Target | undefined, kind: ArtifactKind, scope: Scope): boolean {
  const mapping = target?.kinds[kind];
  return mapping !== undefined && (mapping.scope === undefined || mapping.scope === scope);
}

export interface KindTargets {
  /** Folders to write, each named by the harness that lays it out. */
  targets: string[];
  /** Selected harnesses that read this kind from nowhere at this scope. */
  unreadable: string[];
}

/**
 * The fewest folders that reach every selected harness able to read this kind,
 * so a folder several of them share is written once and nothing lists twice.
 * `wrapped` items sit in plugin folders, which another tool cannot read through.
 */
export function placementFor(
  kind: ArtifactKind,
  selected: readonly string[],
  harnesses: Harnesses,
  scope: Scope,
  wrapped = false,
): KindTargets {
  const needs: string[][] = [];
  const unreadable: string[] = [];
  for (const name of new Set(selected)) {
    if (harnesses[name] === undefined) continue;
    // Another tool's plugin folder nests each item a level deeper than this one looks.
    const reads = readsFor(harnesses, name, kind).filter(
      (read) =>
        placeable(harnesses[read], kind, scope) &&
        (read === name || !wrapped || !takesPlugin(harnesses[read] as Target, scope)),
    );
    if (reads.length === 0) unreadable.push(name);
    else needs.push(reads);
  }

  // Shared folders first, then each tool's own preference, then the name.
  const coverage = new Map<string, number>();
  const rank = new Map<string, number>();
  for (const reads of needs) {
    reads.forEach((read, index) => {
      coverage.set(read, (coverage.get(read) ?? 0) + 1);
      rank.set(read, Math.min(rank.get(read) ?? index, index));
    });
  }
  const candidates = [...coverage.keys()].sort(
    (a, b) =>
      (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0) ||
      (rank.get(a) ?? 0) - (rank.get(b) ?? 0) ||
      a.localeCompare(b),
  );
  const covers = (chosen: readonly string[]) =>
    needs.every((reads) => reads.some((read) => chosen.includes(read)));

  // Exact for the handful of folders a machine has; greedy past that.
  if (candidates.length <= 12) {
    for (let size = 1; size <= candidates.length; size++) {
      for (const chosen of combinations(candidates, size)) {
        if (covers(chosen)) return { targets: chosen, unreadable };
      }
    }
  }
  const chosen: string[] = [];
  for (const reads of needs) {
    if (!reads.some((read) => chosen.includes(read))) chosen.push(reads[0] as string);
  }
  return { targets: chosen, unreadable };
}

function* combinations(items: readonly string[], size: number, start = 0): Generator<string[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let index = start; index <= items.length - size; index++) {
    for (const rest of combinations(items, size - 1, index + 1)) {
      yield [items[index] as string, ...rest];
    }
  }
}

/** Every folder the selected harnesses read, for finding what already sits in them. */
export function readTargets(selected: readonly string[], harnesses: Harnesses): string[] {
  const out = new Set<string>();
  for (const name of selected) {
    if (harnesses[name] === undefined) continue;
    out.add(name);
    for (const reads of Object.values(harnesses[name].reads)) {
      for (const read of reads) if (harnesses[read] !== undefined) out.add(read);
    }
  }
  return [...out];
}

type DetectionRule = "env" | "binary" | "project" | "user";

export interface Detection {
  target: Target;
  detected: boolean;
  /** Which rule fired, so `aireg harnesses` can explain itself. */
  by: DetectionRule | undefined;
}

/** Prefer an explicit signal - env, then binary - over a directory that may be stale. */
function detect(target: Target, cwd: string, env: NodeJS.ProcessEnv = process.env): Detection {
  const signals = target.detect;
  if (signals === "never") return { target, detected: false, by: undefined };

  if (signals.env.some((name) => present(name, env))) return { target, detected: true, by: "env" };
  if (signals.binary.some((binary) => onPath(binary, env))) {
    return { target, detected: true, by: "binary" };
  }
  const project = [target.projectRoot, ...signals.paths.filter((path) => !path.startsWith("~/"))];
  if (project.some((path) => existsSync(join(cwd, path)))) {
    return { target, detected: true, by: "project" };
  }
  const user = [target.userRoot, ...signals.paths.filter((path) => path.startsWith("~/"))];
  if (user.some((path) => existsSync(expandUserPath(path, env)))) {
    return { target, detected: true, by: "user" };
  }
  return { target, detected: false, by: undefined };
}

export function detectAll(
  harnesses: Harnesses,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Detection[] {
  return names(harnesses).map((name) => detect(harnesses[name] as Target, cwd, env));
}

/** Honors the harness's own env override, which users of both tools rely on. */
export function targetRoot(
  target: Target,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (scope !== "user") return join(cwd, target.projectRoot);
  const override = target.envHome === undefined ? undefined : env[target.envHome]?.trim();
  return override !== undefined && override !== "" ? resolve(override) : target.userRoot;
}

/** Undefined when the harness does not load that kind. */
export function projectionPath(
  target: Target,
  kind: ArtifactKind,
  name: string,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const mapping = target.kinds[kind];
  // `contents` has no path of its own: the caller places what it holds.
  if (mapping === undefined || mapping.subdir === undefined) return undefined;
  if (mapping.scope !== undefined && mapping.scope !== scope) return undefined;
  // Harnesses discover artifacts one level deep, so a namespaced name lands flat.
  const base = name.split("/").at(-1) ?? name;
  const leaf = mapping.shape === "file" ? `${base}${mapping.extension ?? ""}` : base;
  return join(targetRoot(target, scope, cwd, env), mapping.subdir, leaf);
}

/** True when this harness loads a directory of artifacts as one plugin. */
export function takesPlugin(target: Target, scope: Scope = "user"): boolean {
  const mapping = target.kinds.plugin;
  if (mapping === undefined || mapping.shape !== "directory" || mapping.subdir === undefined) {
    return false;
  }
  // A kind pinned to one scope is not placed in the others at all.
  return mapping.scope === undefined || mapping.scope === scope;
}

/** `{name}` and `{source}` in a kind `subdir`. */
function expandPlacement(
  template: string,
  values: Readonly<{ name: string; source: string }>,
): string {
  return template.replace(/\{(source|name)\}/g, (_, key: "source" | "name") =>
    sanitizeName(values[key]),
  );
}

/** Where a harness expects a whole plugin to sit. */
export function pluginProjection(
  target: Target,
  namespace: string,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  source: string = namespace,
): string | undefined {
  const mapping = target.kinds.plugin;
  if (mapping?.subdir === undefined) return undefined;
  const root = targetRoot(target, scope, cwd, env);
  if (mapping.subdir.includes("{")) {
    return join(root, expandPlacement(mapping.subdir, { name: namespace, source }));
  }
  return join(root, mapping.subdir, namespace);
}
