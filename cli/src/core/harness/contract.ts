import type { ArtifactKind } from "#core/kinds.ts";

/** Places nothing of its own: a container's members land where their own kinds go. */
interface ContentsMapping {
  shape: "contents";
  subdir?: undefined;
  extension?: undefined;
  scope?: undefined;
  place?: undefined;
  manifest?: undefined;
  register?: undefined;
  render?: undefined;
}

/** A folder per artifact, under `subdir`; strings take `{name}` and `{source}`. */
interface DirectoryMapping {
  shape: "directory";
  subdir: string;
  extension?: undefined;
  /** For a harness that reads this kind from the user installation alone. */
  scope?: "user" | undefined;
  /** `fan` places a real directory of links, for a harness that will not load a linked one. */
  place?: "link" | "fan" | undefined;
  /** Manifests a plugin directory needs, written only when missing. */
  manifest?: ManifestEntry[] | undefined;
  /** Edits to the harness's own config that make it load what was placed, applied in order. */
  register?: RegisterEntry[] | undefined;
  render?: undefined;
}

/** One file per artifact, `<subdir>/<name><extension>`. */
interface FileMapping {
  shape: "file";
  subdir: string;
  extension: string;
  scope?: "user" | undefined;
  place?: undefined;
  manifest?: undefined;
  register?: undefined;
  /** Written as a real file in the harness's own format. */
  render?: Render | undefined;
}

/** The front-matter `fields`, each required, and the Markdown body under `body`; nothing else. */
export interface Render {
  format: "toml";
  fields: string[];
  body: string;
}

/** Where one artifact kind lands inside a harness root. */
export type KindMapping = ContentsMapping | DirectoryMapping | FileMapping;

/** One manifest in a plugin directory, as a harness reads it. */
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
 * One edit to a config file a harness reads. Every placement whose templates
 * expand to the same entry shares it, and it is removed with the last of them.
 */
interface RegisterBase {
  /** Relative to the harness root. */
  file: string;
  format: "toml" | "json";
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
      }
    | {
        /** One item per placement in the JSON list at `at`, matched on `key`. */
        upsert: { key: string; item: Record<string, ConfigValue> };
        value?: undefined;
      }
  );

/** The signals that a harness is installed, or `never` when it must be named. */
interface Detect {
  /** Variables that, set, mean it is installed. */
  env?: string[] | undefined;
  /** Executables that, on PATH, mean it is installed. */
  binary?: string[] | undefined;
  /** Folders beyond its roots that mean it is installed: `~/` for home, else the project. */
  paths?: string[] | undefined;
  /** Variables that, set, mean this process runs inside it. */
  caller?: string[] | undefined;
}

/** One harness aireg installs into, as its module under `src/harnesses` defines it. */
export interface HarnessDefinition {
  id: string;
  displayName: string;
  /** The runtime a registry agent written for this harness names. */
  runtime?: string | undefined;
  /**
   * Installed into when a manifest names none. Fixed rather than detected, so
   * teammates with different tools still write the same lock.
   */
  default?: boolean | undefined;
  /** Its folders hold artifacts `init --import` reads. */
  importable?: boolean | undefined;
  /** A folder several tools read rather than a tool: never detected, never a default. */
  shared?: boolean | undefined;
  roots: {
    project: string;
    /** `default` is under `~/`; `env` names the variable the harness itself reads to move it. */
    user: { default: string; env?: string | undefined };
  };
  detect?: Detect | "never" | undefined;
  /**
   * The folders this tool reads each kind from, most preferred first, named by
   * their entry. Absent means its own folder for every kind it maps.
   */
  reads?: Partial<Record<ArtifactKind, string[]>> | undefined;
  kinds: Partial<Record<ArtifactKind, KindMapping>>;
}

/** What `detect` checks, every list present. */
interface Signals {
  env: string[];
  binary: string[];
  paths: string[];
}

/** A definition with its user root expanded and every default filled in. Data only. */
export interface Target {
  name: string;
  displayName: string;
  projectRoot: string;
  userRoot: string;
  envHome: string | undefined;
  detect: Signals | "never";
  kinds: Partial<Record<ArtifactKind, KindMapping>>;
  /** Only the kinds whose reads differ from this harness's own folder. */
  reads: Partial<Record<ArtifactKind, string[]>>;
  shared: boolean;
}

export type Harnesses = Record<string, Target>;

/** Typed so a definition is checked as it is written. */
export function defineHarness(definition: HarnessDefinition): HarnessDefinition {
  return definition;
}
