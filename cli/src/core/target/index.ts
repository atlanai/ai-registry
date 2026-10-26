import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { onPath } from "#adapter/paths.ts";
import { sanitizeName } from "#adapter/text.ts";
import { present } from "#core/env.ts";
import { expandUserPath } from "#core/fs/path.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { Scope } from "#core/store/paths.ts";
import { codecOf } from "#core/target/codecs/index.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import type {
  EarlierTarget,
  KindMapping,
  Target,
  TargetCategory,
  TargetDefinition,
  Targets,
} from "./contract.ts";
import { BUILT_IN, loadTargetFiles } from "./load.ts";

export type { EarlierTarget, KindMapping, Target, Targets } from "./contract.ts";

/** The tools a manifest installs into when it names none, in the order they are listed. */
export const DEFAULT_TARGETS: readonly string[] = BUILTIN_TARGETS.filter(
  (target) => target.default === true,
).map((target) => target.id);

/** The targets whose folders hold artifacts worth importing, by name. */
export const IMPORTABLE_TARGETS: readonly string[] = BUILTIN_TARGETS.filter(
  (target) => target.importable === true,
)
  .map((target) => target.id)
  .sort();

/**
 * The id aireg 0.1 knew a built-in by, its first alias, `<id>:<profile>` included; any other
 * as given. Only while the table still reads that alias as this target, so a writer never
 * records an id the next command cannot resolve.
 */
export function earlierId(targetTable: Targets, id: string): string {
  const at = id.indexOf(":");
  const base = at === -1 ? id : id.slice(0, at);
  const was = BUILTIN_TARGETS.find((target) => target.id === base)?.aliases?.[0];
  if (was === undefined || canonicalId(targetTable, was) !== base) return id;
  return at === -1 ? was : `${was}${id.slice(at)}`;
}

const EARLIER_KINDS = {
  "coding-agent": "coding",
  "personal-agent": "personal",
  "shared-folder": "shared",
} as const satisfies Record<TargetCategory, EarlierTarget["kind"]>;

/** A record keyed by target id, keyed instead by `earlierId`. */
export function byEarlierIds<T>(targetTable: Targets, byId: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(byId).map(([id, value]) => [earlierId(targetTable, id), value]),
  );
}

/** The table keyed and named by `earlierId`, for adapters built against aireg 0.1. */
export function earlierTable(targetTable: Targets): Record<string, EarlierTarget> {
  const out: Record<string, EarlierTarget> = {};
  for (const target of Object.values(targetTable)) {
    const name = earlierId(targetTable, target.name);
    const reads = Object.fromEntries(
      Object.entries(target.reads).map(([kind, ids]) => [
        kind,
        ids.map((read) => earlierId(targetTable, read)),
      ]),
    );
    out[name] = { ...target, name, reads, kind: EARLIER_KINDS[target.category] };
  }
  return out;
}

/** Variables that name the coding agent running this process, in the order they are checked. */
export const CALLER_SIGNALS: readonly { agent: string; env: readonly string[] }[] =
  BUILTIN_TARGETS.flatMap((target) =>
    target.detect === "never" || target.detect?.caller === undefined
      ? []
      : [{ agent: target.id, env: target.detect.caller }],
  );

/** Every mapping as the rest of aireg reads it: a `render` becomes the codec it names. */
function kindsOf(definition: TargetDefinition): Target["kinds"] {
  const kinds: Target["kinds"] = {};
  for (const [kind, mapping] of Object.entries(definition.kinds) as [ArtifactKind, KindMapping][]) {
    if (mapping.shape !== "file" || mapping.render === undefined) {
      kinds[kind] = structuredClone(mapping);
      continue;
    }
    const { render: _, ...rest } = mapping;
    kinds[kind] = { ...structuredClone(rest), codec: codecOf(mapping) };
  }
  return kinds;
}

/** A definition as data that crosses the daemon RPC, with every default filled in. */
function toTarget(
  definition: TargetDefinition,
  env: NodeJS.ProcessEnv,
  origin: string = BUILT_IN,
): Target {
  const detect = definition.detect ?? {};
  const category = definition.category ?? "coding-agent";
  return {
    name: definition.id,
    aliases: [...(definition.aliases ?? [])],
    displayName: definition.displayName,
    projectRoot: definition.roots.project,
    userRoot: expandUserPath(definition.roots.user.default, env),
    envHome: definition.roots.user.env,
    envWithin: definition.roots.user.within,
    detect:
      detect === "never"
        ? "never"
        : {
            env: detect.env ?? [],
            binary: detect.binary ?? [],
            paths: detect.paths ?? [],
            ...(detect.projectRoot === false ? { projectRoot: false as const } : {}),
          },
    kinds: kindsOf(definition),
    reads: { ...definition.reads },
    category,
    shared: category === "shared-folder",
    verified: definition.verified === undefined ? undefined : structuredClone(definition.verified),
    trust: { ...definition.trust },
    reload: definition.reload,
    origin,
  };
}

/** A profile name as both its folder and a target id can carry it. */
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Each profile folder its `profiles` root finds, as a target of its own. */
function profilesOf(definition: TargetDefinition, env: NodeJS.ProcessEnv, origin: string) {
  const root = definition.profiles?.root;
  if (root === undefined) return [];
  const pattern = expandUserPath(root, env);
  const [prefix, suffix] = basename(pattern).split("{profile}") as [string, string];
  let found: string[];
  try {
    found = readdirSync(dirname(pattern), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return found.flatMap((folder): Target[] => {
    if (!folder.startsWith(prefix) || !folder.endsWith(suffix)) return [];
    const profile = folder.slice(prefix.length, folder.length - suffix.length);
    if (!PROFILE.test(profile)) return [];
    const base = toTarget(definition, env, origin);
    return [
      {
        ...base,
        // A profile is this machine's alone, so a project never installs into it.
        kinds: Object.fromEntries(
          Object.entries(base.kinds).map(([kind, mapping]) => [
            kind,
            mapping.shape === "contents" ? mapping : { ...mapping, scope: "user" },
          ]),
        ),
        name: `${definition.id}:${profile}`,
        // `<alias>:<profile>` reaches it through its definition's aliases.
        aliases: [],
        displayName: `${definition.displayName} (${profile})`,
        userRoot: join(dirname(pattern), folder),
        envHome: undefined,
        envWithin: undefined,
      },
    ];
  });
}

/** The built-in targets and the ones your user scope defines, as data that crosses the daemon RPC. */
export function resolveTargets(env: NodeJS.ProcessEnv = process.env): Targets {
  const definitions = new Map<string, { definition: TargetDefinition; origin: string }>();
  for (const definition of BUILTIN_TARGETS) {
    definitions.set(definition.id, { definition, origin: BUILT_IN });
  }
  for (const file of loadTargetFiles(env).files) {
    definitions.set(file.definition.id, { definition: file.definition, origin: file.path });
  }
  const out: Targets = {};
  for (const { definition, origin } of definitions.values()) {
    out[definition.id] = toTarget(definition, env, origin);
    for (const profile of profilesOf(definition, env, origin)) out[profile.name] = profile;
  }
  for (const target of Object.values(out)) {
    for (const [kind, reads] of Object.entries(target.reads) as [ArtifactKind, string[]][]) {
      target.reads[kind] = canonicalIds(out, reads);
    }
  }
  return out;
}

/** The id an id or one of its aliases names, `<alias>:<profile>` included; any other as given. */
export function canonicalId(targetTable: Targets, id: string): string {
  if (Object.hasOwn(targetTable, id)) return id;
  const at = id.indexOf(":");
  const base = at === -1 ? id : id.slice(0, at);
  const owner = Object.values(targetTable).find((target) => target.aliases.includes(base));
  if (owner === undefined) return id;
  return at === -1 ? owner.name : `${owner.name}${id.slice(at)}`;
}

/** Each as its canonical id, once, in the order given. */
export function canonicalIds(targetTable: Targets, ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => canonicalId(targetTable, id)))];
}

export function names(targetTable: Targets): string[] {
  return Object.keys(targetTable).sort();
}

/** The folders a target reads a kind from, most preferred first. */
export function readsFor(targetTable: Targets, name: string, kind: ArtifactKind): string[] {
  const target = targetTable[name];
  if (target === undefined) return [];
  return target.reads[kind] ?? (target.kinds[kind] === undefined ? [] : [name]);
}

function placeable(target: Target | undefined, kind: ArtifactKind, scope: Scope): boolean {
  const mapping = target?.kinds[kind];
  return mapping !== undefined && (mapping.scope === undefined || mapping.scope === scope);
}

export interface KindTargets {
  /** Folders to write, each named by the target that lays it out. */
  targets: string[];
  /** Selected targets that read this kind from nowhere at this scope. */
  unreadable: string[];
}

/**
 * The fewest folders that reach every selected target able to read this kind,
 * so a folder several of them share is written once and nothing lists twice.
 * `wrapped` items sit in plugin folders, which another tool cannot read through.
 */
export function placementFor(
  kind: ArtifactKind,
  selected: readonly string[],
  targetTable: Targets,
  scope: Scope,
  wrapped = false,
): KindTargets {
  const needs: string[][] = [];
  const unreadable: string[] = [];
  for (const name of new Set(selected)) {
    if (targetTable[name] === undefined) continue;
    // Another tool's plugin folder nests each item a level deeper than this one looks.
    const reads = readsFor(targetTable, name, kind).filter(
      (read) =>
        placeable(targetTable[read], kind, scope) &&
        (read === name || !wrapped || !takesPlugin(targetTable[read] as Target, scope)),
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

/** Every folder the selected targets read, for finding what already sits in them. */
export function readTargets(selected: readonly string[], targetTable: Targets): string[] {
  const out = new Set<string>();
  for (const name of selected) {
    if (targetTable[name] === undefined) continue;
    out.add(name);
    for (const reads of Object.values(targetTable[name].reads)) {
      for (const read of reads) if (targetTable[read] !== undefined) out.add(read);
    }
  }
  return [...out];
}

type DetectionRule = "env" | "binary" | "project" | "user";

export interface Detection {
  target: Target;
  detected: boolean;
  /** Which rule fired, so `aireg targets` can explain itself. */
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
  const project = [
    ...(signals.projectRoot === false ? [] : [target.projectRoot]),
    ...signals.paths.filter((path) => !path.startsWith("~/")),
  ];
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
  targetTable: Targets,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Detection[] {
  return names(targetTable).map((name) => detect(targetTable[name] as Target, cwd, env));
}

/** Honors the target's own env override, which users of both tools rely on. */
export function targetRoot(
  target: Target,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (scope !== "user") return join(cwd, target.projectRoot);
  const override = target.envHome === undefined ? undefined : env[target.envHome]?.trim();
  if (override === undefined || override === "") return target.userRoot;
  return resolve(override, target.envWithin ?? "");
}

/** Undefined when the target does not load that kind. */
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
  // Targets discover artifacts one level deep, so a namespaced name lands flat.
  const base = name.split("/").at(-1) ?? name;
  const leaf = mapping.shape === "file" ? `${base}${mapping.extension ?? ""}` : base;
  return join(targetRoot(target, scope, cwd, env), mapping.subdir, leaf);
}

/** The command a person runs before this target loads a kind placed at `scope`, if any. */
export function trustFor(target: Target, kind: ArtifactKind, scope: Scope): string | undefined {
  const trust = target.trust[kind];
  return trust === undefined || (trust.scope ?? scope) !== scope ? undefined : trust.run;
}

/** True when this target loads a directory of artifacts as one plugin. */
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

/** Where a target expects a whole plugin to sit. */
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
