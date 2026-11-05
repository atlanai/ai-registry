import type { ArtifactKind } from "#adapter/kinds.ts";

/** Places nothing of its own: a container's members land where their own kinds go. */
interface ContentsMapping {
  shape: "contents";
  subdir?: undefined;
  extension?: undefined;
  scope?: undefined;
  place?: undefined;
  entry?: undefined;
  manifest?: undefined;
  register?: undefined;
  codec?: undefined;
  keys?: undefined;
  render?: undefined;
}

/** A folder per artifact, under `subdir`; strings take `{name}` and `{source}`. */
interface DirectoryMapping {
  shape: "directory";
  subdir: string;
  extension?: undefined;
  /** For a target that reads this kind from the user installation alone. */
  scope?: "user" | undefined;
  /**
   * `fan` places a real directory of links, for a target that will not load a linked one;
   * `copy` real files, for one that rewrites or refuses links.
   */
  place?: "link" | "fan" | "copy" | undefined;
  /** For a file-shaped kind: the file's name inside its folder, written as a copy. */
  entry?: string | undefined;
  /** A plugin directory's manifests: the plugin's own if it has one, else written if missing. */
  manifest?: ManifestEntry[] | undefined;
  /** Edits to the target's own config that make it load what was placed, applied in order. */
  register?: RegisterEntry[] | undefined;
  /** Rewrites the `entry` file in the target's own format. */
  codec?: Codec | undefined;
  /** Front-matter keys it reads elsewhere (a file it reads instead) or not at all (false). */
  keys?: Record<string, KeyFile | false> | undefined;
  render?: undefined;
}

export interface KeyFile {
  /** Relative to the artifact's folder; `.json`, `.yaml` or `.yml`. */
  path: string;
  body: Record<string, ConfigValue>;
}

/** One file per artifact, `<subdir>/<name><extension>`. */
interface FileMapping {
  shape: "file";
  subdir: string;
  extension: string;
  scope?: "user" | undefined;
  /** `copy` writes a real file, for a target that rewrites or refuses links. */
  place?: "link" | "copy" | undefined;
  entry?: undefined;
  manifest?: undefined;
  register?: undefined;
  /** Written as a real file in the target's own format. */
  codec?: Codec | undefined;
  keys?: undefined;
  /** @deprecated Read as the `frontmatter-toml` codec; use `codec`. */
  render?: Render | undefined;
}

/** @deprecated The `frontmatter-toml` codec, under its earlier name. */
export interface Render {
  format: "toml";
  fields: string[];
  body: string;
}

/**
 * A built-in rewrite of the file a target reads, chosen by id; a definition never carries code.
 * A strict or set codec never drops or changes a key that limits an agent, `restrictions` included.
 */
export type Codec =
  /** The front-matter `fields`, each required, and the Markdown body under `body`; nothing else. */
  | { id: "frontmatter-toml"; fields: string[]; body: string }
  /** Only the front-matter keys in `keep`; dropping a key that limits the agent is refused. */
  | { id: "frontmatter-strict"; keep: string[]; restrictions?: string[] | undefined }
  /** Front-matter keys set to fixed values; changing a key that limits the agent is refused. */
  | {
      id: "frontmatter-set";
      set: Record<string, ConfigValue>;
      restrictions?: string[] | undefined;
    };

/** Where one artifact kind lands inside a target root. */
export type KindMapping = ContentsMapping | DirectoryMapping | FileMapping;

/** One manifest in a plugin directory, as a target reads it. */
interface ManifestEntry {
  /** Relative to the plugin directory. */
  path: string;
  /** Keys over the common plugin document; strings take `{name}` and `{description}`. */
  body?: Record<string, ConfigValue> | undefined;
}

export type ConfigValue =
  | string
  | number
  | boolean
  | ConfigValue[]
  | { [key: string]: ConfigValue };

/**
 * One edit to a config file a target reads. Every placement whose templates
 * expand to the same entry shares it, and it is removed with the last of them.
 */
interface RegisterBase {
  /** Relative to the target root. */
  file: string;
  format: "toml" | "json" | "yaml";
  /** Key path to the table this entry writes in. */
  at: string[];
  /** What a missing file starts as; one back to this on removal is deleted. */
  init?: Record<string, ConfigValue> | undefined;
  /** `keep` leaves a table already set to other values to whoever set it. */
  conflict?: "overwrite" | "keep" | undefined;
  /** `entry` drops the whole table on removal; `ours` only the keys it wrote. */
  remove?: "ours" | "entry" | undefined;
  /** Written instead of removing ours when the table holds someone else's keys too. */
  off?: Record<string, ConfigValue> | undefined;
}

export type RegisterEntry = RegisterBase &
  (
    | {
        /** Keys set in the table at `at`. */
        value: Record<string, ConfigValue>;
        upsert?: undefined;
        append?: undefined;
      }
    | {
        /** One item per placement in the list at `at`, matched on `key`. */
        upsert: { key: string; item: Record<string, ConfigValue> };
        value?: undefined;
        append?: undefined;
      }
    | {
        /** One text item in the list at `at`, kept while any placement it expands for remains. */
        append: string;
        value?: undefined;
        upsert?: undefined;
      }
  );

/** The signals that a target is installed, or `never` when it must be named. */
interface Detect {
  /** Variables that, set, mean it is installed. */
  env?: string[] | undefined;
  /** Executables that, on PATH, mean it is installed. */
  binary?: string[] | undefined;
  /** Folders beyond its roots that mean it is installed: `~/` for home, else the project. */
  paths?: string[] | undefined;
  /** `false` when its project folder is one many repositories hold anyway, so it proves nothing. */
  projectRoot?: false | undefined;
  /** Variables that, set, mean this process runs inside it. */
  caller?: string[] | undefined;
}

/** Profiles of one installation, each installed into as its own target, `<id>:<profile>`. */
interface Profiles {
  /** A profile's user root, under `~/`; `{profile}` in its last segment names each one. */
  root: string;
}

/** A command a person runs before a target loads what it was given, at `scope` alone when set. */
interface Trust {
  run: string;
  scope?: "project" | "user" | undefined;
}

/** What a target is; a `shared-folder` is several tools' folder, never detected nor a default. */
export type TargetCategory = "coding-agent" | "personal-agent" | "shared-folder";

/** One target aireg installs into, as its module under `src/targets` defines it. */
export interface TargetDefinition {
  id: string;
  /** Other ids it answers to wherever an id is read, such as an earlier one; output names `id`. */
  aliases?: string[] | undefined;
  displayName: string;
  /** `coding-agent` when absent. */
  category?: TargetCategory | undefined;
  /**
   * Installed into when a manifest names none. Fixed rather than detected, so
   * teammates with different tools still write the same lock.
   */
  default?: boolean | undefined;
  /** Its folders hold artifacts `init --import` reads. */
  importable?: boolean | undefined;
  roots: {
    project: string;
    /**
     * `default` is under `~/`; `env` names the variable the target itself reads to move it,
     * and `within` the root's path inside the folder that variable names, when not the folder itself.
     */
    user: { default: string; env?: string | undefined; within?: string | undefined };
  };
  detect?: Detect | "never" | undefined;
  /**
   * The folders this tool reads each kind from, most preferred first, named by
   * their entry. Absent means its own folder for every kind it maps.
   */
  reads?: Partial<Record<ArtifactKind, string[]>> | undefined;
  kinds: Partial<Record<ArtifactKind, KindMapping>>;
  /** The program and arguments that print its version, and the versions this was checked against. */
  verified?: { command: string[]; range: string } | undefined;
  /** A command a person runs before the target loads a kind it was given; printed, never run. */
  trust?: Partial<Record<ArtifactKind, Trust>> | undefined;
  profiles?: Profiles | undefined;
  /** What to do after a change for the target to see it; printed, never run. */
  reload?: string | undefined;
}

/** What `detect` checks, every list present. */
interface Signals {
  env: string[];
  binary: string[];
  paths: string[];
  projectRoot?: false | undefined;
}

/** A definition with its user root expanded and every default filled in. Data only. */
export interface Target {
  name: string;
  aliases: string[];
  displayName: string;
  projectRoot: string;
  userRoot: string;
  envHome: string | undefined;
  /** The root's path inside the folder `envHome` names, when not that folder itself. */
  envWithin: string | undefined;
  detect: Signals | "never";
  kinds: Partial<Record<ArtifactKind, KindMapping>>;
  /** Only the kinds whose reads differ from this target's own folder. */
  reads: Partial<Record<ArtifactKind, string[]>>;
  category: TargetCategory;
  /** A `shared-folder`, which is what most callers ask. */
  shared: boolean;
  verified: { command: string[]; range: string } | undefined;
  trust: Partial<Record<ArtifactKind, Trust>>;
  reload: string | undefined;
  /** Built in, or the path of the file in your user scope that defines it. */
  origin: string;
}

export type Targets = Record<string, Target>;

/** A target as aireg 0.1 handed it to an adapter, which read `kind` and the ids it knew. */
export interface EarlierTarget extends Target {
  kind: "coding" | "personal" | "shared";
}

/** Typed so a definition is checked as it is written. */
export function defineTarget(definition: TargetDefinition): TargetDefinition {
  return definition;
}
