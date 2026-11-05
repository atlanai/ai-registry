import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { codecOf } from "#core/target/codecs/index.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import type { KindMapping, Target, TargetDefinition, Targets } from "./contract.ts";
import { canonicalIds } from "./ids.ts";
import { BUILT_IN, loadTargetFiles } from "./load.ts";

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
    // A profile is this machine's alone, so a project never installs into it. Its aliases stay
    // empty: `<alias>:<profile>` reaches it through its definition's aliases.
    return [
      {
        ...base,
        kinds: Object.fromEntries(
          Object.entries(base.kinds).map(([kind, mapping]) => [
            kind,
            mapping.shape === "contents" ? mapping : { ...mapping, scope: "user" },
          ]),
        ),
        name: `${definition.id}:${profile}`,
        aliases: [],
        displayName: `${definition.displayName} (${profile})`,
        userRoot: join(dirname(pattern), folder),
        envHome: undefined,
        envWithin: undefined,
      },
    ];
  });
}
