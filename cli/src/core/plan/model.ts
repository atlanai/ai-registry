import type { AdapterError, Envelope } from "#adapter/index.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import type { LayoutId } from "#adapter/layouts/ids.ts";
import type { SourceConfig } from "#core/adapter/identity.ts";
import type { Catalog } from "#core/catalog/catalog.ts";
import type { Withheld } from "#core/catalog/withheld.ts";
import type { LinkMode, Lock } from "#core/lock.ts";
import type { Codec, KeyFile } from "#core/target/contract.ts";
import type { Carried } from "./carries.ts";
import type { Conflict, Need, Unresolved } from "./depends.ts";
import type { Untrusted } from "./select.ts";
import type { Unlisted } from "./unlisted.ts";

export interface Origin {
  adapter: string;
  /** Expanded for the adapter to read; absolute where it is a path. */
  location: string;
  /** As the manifest wrote it, so a committed lock does not pin the writer's directory. */
  declared: string;
  key: string;
  config: SourceConfig;
  /** Undefined unless one revision covers the whole source. */
  revision: string | undefined;
  layout?: LayoutId | undefined;
}

/** Upstream identity known before content is fetched. */
export interface Placement {
  /** Source-owned, stable across a rename. */
  id: string;
  name: string;
  /** Content digest; undefined when read from a lock row without one. */
  contentId: string | undefined;
  version: string | undefined;
  needs?: readonly Need[] | undefined;
  /** Withdrawn by the registry, and served only because something pinned it. */
  yanked?: { reason: string | undefined } | undefined;
  /** Present only for a status that installs with a warning, such as `deprecated`. */
  status?: { name: string; reason: string | undefined } | undefined;
  /** For a plugin read from a source that is not a registry, what places it. */
  plugin?: PluginDocument | undefined;
  /** The commit it was read at, where that is its own rather than the registry's. */
  revision?: string | undefined;
  leftOut?: { entry: string; files: readonly string[] } | undefined;
}

export interface Acquired {
  alias: string;
  origin: Origin;
  /** Keyed by catalog entry path. */
  placements: Map<string, Placement>;
  catalog: Catalog;
  /** Its adapter declares each namespace a plugin; absent is off. */
  namespacePlugins?: boolean;
  /** Read whole this run, so its catalog is everything it lists, not only what was asked for. */
  whole?: boolean;
  content: (entryPath: string) => Promise<Staged>;
  close: () => Promise<void>;
}

export interface Staged {
  path: string;
  /** The version directory, which holds the native files. */
  root: string;
  contentId: string;
  /** Written into the mirror as `artifact.json`, which is what makes it a root. */
  envelope: Envelope;
  dropped: { member: string; reason: string; error: AdapterError | undefined }[];
}

export type Fetch = (source: string, path: string) => Promise<Staged>;

/** For one front-matter key: the files its readers take it from, and who cannot keep it. */
export interface KeyRule {
  files: KeyFile[];
  refusedBy: string[];
}

export type Action =
  /** Fetch and stage content only when this action is applied. */
  | { kind: "stage"; name: string; source: string; path: string; to: string }
  /** This scope's writable copy of a staged version directory, so an edit stops in this scope. */
  | { kind: "clone"; name: string; from: string; to: string }
  | {
      kind: "link";
      name: string;
      /** Target name, as on `LockLink`. */
      target: string;
      from: string;
      to: string;
      copy: boolean;
      /** Points the target at a whole plugin, which has to be assembled. */
      plugin?: boolean;
      /** Present with `plugin`: the content this projection links to. */
      content?: string;
      document?: PluginDocument;
      /** A real copy already at `to`, holding exactly these bytes, is taken over rather than rewritten. */
      adopt?: boolean;
      /** How the lock recorded a link at this path; absent when aireg made none. */
      recorded?: LinkMode;
      /** Placed as a real directory of links rather than one link. */
      fan?: boolean;
      /** Absent writes the bytes as they are. */
      codec?: Codec;
      /** A plugin's command, written as a skill a person invokes under this name. */
      command?: string;
      /** Front-matter keys a target reading this folder does not read as written. */
      keys?: Record<string, KeyRule>;
      /** The kind of the plugin part this places, where a target takes the plugin as its parts. */
      part?: ArtifactKind;
      /** Written as a real folder holding this file. */
      entry?: string;
      /** The name the copy's front matter takes: it installs under a name not its own. */
      rename?: string;
    }
  | {
      kind: "unlink";
      name: string;
      to: string;
      /** This scope's copy, holding edits made after installation. */
      edited?: boolean;
      /** The target link the lock recorded here, when this is one. */
      link?: { target: string; mode: LinkMode };
    }
  | { kind: "record"; lock: Lock };

export interface Warning {
  name: string | undefined;
  message: string;
  /** Printed on its own line. */
  hint?: string;
}

export interface Plan {
  actions: Action[];
  /** Artifacts already correct on disk. */
  unchanged: string[];
  warnings: Warning[];
  /** Explicitly requested artifacts this CLI is too old to install. */
  incompatible: Incompatible[];
  rewritten: Rewritten[];
  clashes: Clash[];
  renamed: Renamed[];
  /** Installed name of each dependency-only install, mapped to the names that need it. */
  neededBy: Record<string, string[]>;
  /** Dependencies nothing needs any more. */
  pruned: string[];
  unresolved: Unresolved[];
  conflicts: Conflict[];
  /** Installed artifacts kept as they are, because the registry withholds the version it reached. */
  withheld: Kept[];
  unlisted: Unlisted[];
  untrusted: Untrusted[];
}

export interface Kept {
  name: string;
  installed: string | undefined;
  withheld: Withheld;
  absent: boolean;
}

/** One artifact inside a plugin, as the plugin's own directory holds it. */
export interface Contained {
  name: string;
  kind: ArtifactKind;
  /** Path within the plugin directory, POSIX separators. */
  within: string;
  /** A command file, which a target without plugins gets as a skill rendered from it. */
  command?: boolean;
}

/** What a plugin read from a source that is not a registry says about itself, for placing it. */
export interface PluginDocument {
  name: string;
  description?: string | undefined;
  /** The manifest a target loads it by, which a plugin without its own gets written for it. */
  manifest?: Record<string, unknown> | undefined;
  /** Paths are relative to the plugin. */
  commands: readonly { name: string; path: string }[];
  /** What a target that loads it would start on its own, which needs a person's yes. */
  carries: readonly Carried[];
  /** A digest of those parts, so a change to what runs is seen without fetching. */
  fingerprint?: string | undefined;
}

export interface Selected {
  name: string;
  kind: ArtifactKind;
  /** Registry alias. */
  source: string;
  /** The address the registry publishes it at, POSIX separators. */
  path: string;
  /** Source-owned identity, stable across a rename. */
  id: string;
  /** What the source calls it, which a local rename does not change. */
  upstreamName: string;
  /** Upstream content identity, when the source attests one before fetching. */
  contentId: string | undefined;
  version: string | undefined;
  /** For a plugin read from a source that is not a registry, what places it. */
  plugin?: PluginDocument | undefined;
  /** The commit it was read at, where that is its own rather than the registry's. */
  revision?: string | undefined;
  /** A plugin's parts, for a target with no plugin directory; empty for every other kind. */
  contents: Contained[];
  /** The plugin that publishes this, when one does. */
  group: string | undefined;
  /** Targets the manifest narrowed this artifact to; absent means every target the run writes. */
  targets?: readonly string[] | undefined;
  /** The manifest names it, rather than taking it with a whole namespace or registry. */
  named?: boolean;
  /** Copied into each target folder rather than linked. */
  copy?: boolean;
  /** Its name was written with `as:`, so it is never renamed for it. */
  aliased?: boolean;
}

export interface Incompatible {
  name: string;
  engine: string;
}

/** Two addresses that install under one name; the lock is keyed by it, so one is kept. */
export interface Clash {
  name: string;
  kept: string;
  dropped: string;
  /** The target path both would take, when they differ in name but not in where they land. */
  at?: string;
  /** `at` is a namespace's plugin directory, which no rename of the artifact frees. */
  container?: true;
}

/** An artifact installed under another name because another artifact holds its own. */
export interface Renamed {
  /** Registry address. */
  artifact: string;
  as: string;
  /** Registry address of what holds its own name. */
  by: string;
}

/** A locked version the registry now serves other bytes for; `locked` and `served` are content digests. */
export interface Rewritten {
  name: string;
  version: string;
  locked: string;
  served: string;
}

export function recordOf(plan: Plan): Lock {
  const record = plan.actions.find(
    (action): action is Extract<Action, { kind: "record" }> => action.kind === "record",
  );
  if (record === undefined) throw new Error("The plan has no lockfile record.");
  return record.lock;
}
