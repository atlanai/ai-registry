import type { AdapterError, Envelope } from "#adapter/index.ts";
import { quoted } from "#adapter/text.ts";
import type { SourceConfig } from "#core/adapter/identity.ts";
import { type Catalog, type Entry, entryFor } from "#core/catalog/model.ts";
import type { Withheld } from "#core/catalog/withheld.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Codec } from "#core/harness/contract.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { LinkMode, Lock, LockArtifact, LockRegistry } from "#core/lock.ts";
import type { Conflict, Need, Unresolved } from "./depends.ts";

/** One resolved registry, in the shape the lock stores. */
export interface Origin {
  adapter: string;
  /** Expanded: what an adapter reads. Absolute for anything that is a path. */
  location: string;
  /**
   * What the manifest actually says. A relative path stays relative here, so a
   * committed lock does not pin the directory the machine that wrote it used.
   */
  declared: string;
  key: string;
  config: SourceConfig;
  /** What the source was at, when it has one revision covering everything. */
  revision: string | undefined;
}

/** Upstream identity known before content is fetched. */
export interface Placement {
  /** Source-owned, stable across a rename. */
  id: string;
  name: string;
  /** The envelope's content digest, which every source has. */
  contentId: string | undefined;
  version: string | undefined;
  /** What this version's `depends_on` edges name. Absent means nothing. */
  needs?: readonly Need[] | undefined;
  /** Withdrawn by the registry, and served only because something pinned it. */
  yanked?: { reason: string | undefined } | undefined;
}

/** A resolved registry with lazy access to artifact content. */
export interface Acquired {
  alias: string;
  origin: Origin;
  /** Keyed by catalog entry path. */
  placements: Map<string, Placement>;
  catalog: Catalog;
  /** Its adapter declares each namespace a plugin. Absent is off. */
  namespacePlugins?: boolean;
  /** An entry's content on disk, and the identity the store keyed it by. */
  content: (entryPath: string) => Promise<Staged>;
  /** Releases whatever the adapter opened. */
  close: () => Promise<void>;
}

/** Where the bytes are, and what upstream identity they were stored under. */
export interface Staged {
  path: string;
  /** The directory holding the native files, which is what a version directory is. */
  root: string;
  contentId: string;
  /** Written into the mirror as `artifact.json`, which is what makes it a root. */
  envelope: Envelope;
  /** Members of a collection that did not land, and why. Empty on a clean fetch. */
  dropped: { member: string; reason: string; error: AdapterError | undefined }[];
}

export type Fetch = (source: string, path: string) => Promise<Staged>;

/** Resolve content through the registry that produced the catalog entry. */
export function fetchFrom(acquired: readonly Acquired[]): Fetch {
  const byAlias = new Map(acquired.map((entry) => [entry.alias, entry]));
  return (source, path) => {
    const found = byAlias.get(source);
    return found === undefined
      ? Promise.reject(
          new AiregError(`Registry ${quoted(source)} is no longer available.`, {
            code: ErrorCode.NotFound,
          }),
        )
      : found.content(path);
  };
}

/** Where a registry lists a lock row; one of yours has no address until a publish of it is recorded. */
export function listedAt(row: LockArtifact, entries: readonly Entry[]): string | undefined {
  if (row.address !== undefined || row.origin === undefined) return row.address;
  return entryFor(entries, row.namespace, row.kind, row.name)?.path;
}

export function lockSourceOf(origin: Origin): LockRegistry {
  return {
    location: origin.declared,
    adapter: origin.adapter,
    key: origin.key,
    config: origin.config,
    revision: origin.revision,
  };
}

export function dropUnusedSources(lock: Lock): void {
  for (const alias of Object.keys(lock.registries)) {
    const used = Object.values(lock.artifacts).some((entry) => entry.registry === alias);
    if (!used) delete lock.registries[alias];
  }
}

export type Action =
  /** Fetch and stage content only when this action is applied. */
  | { kind: "stage"; name: string; source: string; path: string; to: string }
  /**
   * This scope's own writable copy of a staged version directory. A harness is
   * pointed at the copy, never at the mirror, so an edit stops in this scope.
   */
  | { kind: "clone"; name: string; from: string; to: string }
  | {
      kind: "link";
      name: string;
      /** Harness name, as on `LockLink`. */
      harness: string;
      from: string;
      to: string;
      copy: boolean;
      /** Points the harness at a whole plugin, which has to be assembled. */
      plugin?: boolean;
      /** The content this projection links to. Present with `plugin`. */
      content?: string;
      /** How the lock recorded a link at this path, when aireg made one before. */
      recorded?: LinkMode;
      /** Placed as a real directory of links rather than one link. */
      fan?: boolean;
      /** Written in the harness's own format. */
      codec?: Codec;
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
      /** The harness link the lock recorded here, when this is one. */
      link?: { harness: string; mode: LinkMode };
    }
  | { kind: "record"; lock: Lock };

export interface Warning {
  name: string | undefined;
  message: string;
  /** What to do about it, said on its own line. */
  hint?: string;
}

export interface Plan {
  actions: Action[];
  /** Artifacts already correct on disk. An empty plan is the common case. */
  unchanged: string[];
  warnings: Warning[];
  /** Explicitly requested artifacts this CLI is too old to install. */
  incompatible: Incompatible[];
  /** Locked versions the registry now serves other bytes for. */
  rewritten: Rewritten[];
  /** Artifacts left out because another holds the name they install under. */
  clashes: Clash[];
  /** Artifacts this run installs under another name, because another holds their own. */
  renamed: Renamed[];
  /** What is installed only because other artifacts need it, by installed name: their names. */
  neededBy: Record<string, string[]>;
  /** Dependencies this plan removes because nothing needs them any more. */
  pruned: string[];
  /** Needs no source listed at the version asked for; the caller asks again or refuses. */
  unresolved: Unresolved[];
  /** Requirements no single installation can meet. */
  conflicts: Conflict[];
  /** Installed artifacts kept as they are, because the registry withholds the version it reached. */
  withheld: Kept[];
}

/** An installed artifact the plan keeps, by its installed name, at the version it has. */
export interface Kept {
  name: string;
  installed: string | undefined;
  withheld: Withheld;
}

export function emptyPlan(): Plan {
  return {
    actions: [],
    unchanged: [],
    warnings: [],
    incompatible: [],
    rewritten: [],
    clashes: [],
    renamed: [],
    neededBy: {},
    pruned: [],
    unresolved: [],
    conflicts: [],
    withheld: [],
  };
}

/** What survey found for one locked artifact. */
export interface ArtifactSurvey {
  /** Present in the project's writable copy. */
  staged: boolean;
  /** Undefined when nothing is staged. */
  digest: string | undefined;
  links: Record<
    string,
    {
      present: boolean;
      isLink: boolean;
      target: string | undefined;
      mode: LinkMode;
      /** A copy's digest now, compared with the one the lock recorded. */
      digest?: string | undefined;
    }
  >;
}

export interface Survey {
  artifacts: Record<string, ArtifactSurvey>;
}

/** A harness's copy that no longer matches what was written there. */
export function copyEdited(
  link: { path: string; mode: LinkMode; digest?: string | undefined },
  state: ArtifactSurvey | undefined,
): boolean {
  const seen = state?.links[link.path];
  return (
    link.mode === "copy" &&
    link.digest !== undefined &&
    seen?.digest !== undefined &&
    seen.digest !== link.digest
  );
}

/** The copy here no longer matches what the lock says was installed. */
export function editedHere(
  entry: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
): boolean {
  return (
    state?.staged === true &&
    entry !== undefined &&
    entry.digest !== "" &&
    state.digest !== entry.digest
  );
}

/** Edited in this scope's copy or in a harness's own copy, so not ours to replace unasked. */
export function editedAnywhere(
  entry: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
): boolean {
  return editedHere(entry, state) || (entry?.links ?? []).some((link) => copyEdited(link, state));
}

/** One artifact inside a plugin, as the plugin's own directory holds it. */
export interface Contained {
  name: string;
  kind: ArtifactKind;
  /** Path within the plugin directory, POSIX separators. */
  within: string;
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
  /** The version the source published, where it publishes versions. */
  version: string | undefined;
  /**
   * What a plugin holds, so a harness with no plugin directory can be given
   * its parts. Empty for every other kind.
   */
  contents: Contained[];
  /** The plugin that publishes this, when one does. */
  group: string | undefined;
  /** Harnesses the manifest narrowed this artifact to. */
  targets?: readonly string[] | undefined;
  /** The manifest names it, rather than taking it with a whole namespace or registry. */
  named?: boolean;
  /** Copied into each harness folder rather than linked. */
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
  /** The harness path both would take, when they differ in name but not in where they land. */
  at?: string;
}

/** An artifact installed under another name because another artifact holds its own. */
export interface Renamed {
  /** Its registry address. */
  artifact: string;
  as: string;
  /** The address of what holds its own name. */
  by: string;
}

export interface Rewritten {
  name: string;
  version: string;
  /** The content digest the lock records. */
  locked: string;
  /** The one the registry serves now. */
  served: string;
}
