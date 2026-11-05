import type { ArtifactKind } from "#adapter/kinds.ts";
import type { SourceConfig } from "#core/adapter/identity.ts";
import { dict } from "#core/fields.ts";
import type { Ref } from "#core/ref.ts";
import type { ExportFile } from "./export-fields.ts";

export interface RegistrySource {
  location: string;
  /** Omitted means "ask which adapter recognizes this". */
  adapter: string | undefined;
  config: SourceConfig;
}

export interface Manifest {
  /** Carried so an editor keeps its schema hint when a command rewrites the file. */
  schema: string | undefined;
  name: string | undefined;
  description: string | undefined;
  /** Oldest aireg CLI that can read this file. Plain SemVer, meaning >=. */
  engine: string | undefined;
  /** Empty means `DEFAULT_TARGETS`. */
  targets: string[];
  /** Keyed by the name a reference uses. */
  registries: Record<string, RegistrySource>;
  artifacts: Ref[];
  exports: Export[];
  publish: PublishTarget | undefined;
}

/** Where exports are published, as `--to` takes it. */
export interface PublishTarget {
  /** `<registry>/<namespace>` with the registry declared, or a folder ending in `/<namespace>`. */
  to: string;
}

/** An exported artifact path, glob, or folder whose immediate artifacts are exported. */
export interface Export {
  /** Relative to the project, with `/`; only a plain entry may be a glob. */
  path: string;
  /** When set, every artifact the entry reaches must be this kind. */
  kind?: ArtifactKind | undefined;
  /** The exact version to publish it at, instead of the next one. */
  version: string | undefined;
  dependsOn: ExportDependency[];
  /** `false` keeps it in this repository; absent, it goes to `publish.to`. */
  publish: false | undefined;
  /** For a folder of artifacts, the names directly inside it that it does not reach. */
  exclude?: string[] | undefined;
  /** Gitignore patterns, relative to each artifact it reaches: the files left out. */
  ignore?: string[] | undefined;
  /** When set, the only files each artifact publishes besides its entry file, and where each is stored. */
  include?: ExportFile[] | undefined;
}

/** A local exported path or the unversioned address of a declared installed artifact. */
export type ExportDependency = { type: "local"; path: string } | { type: "remote"; ref: Ref };

/** How aireg 0.1 spells `targets:`, and the key aireg writes unless a manifest says `targets:`. */
export const LEGACY_TARGETS_KEY = "harnesses";

/** The published schema is held to this list. */
export const MANIFEST_KEYS = [
  "$schema",
  "name",
  "description",
  "engines",
  "targets",
  LEGACY_TARGETS_KEY,
  "registries",
  "artifacts",
  "exports",
  "publish",
] as const;

export const EXPORT_KEYS = [
  "path",
  "kind",
  "version",
  "depends_on",
  "publish",
  "exclude",
  "ignore",
  "include",
] as const;

/** Every transport's keys; the adapter decides which are legal together. */
export const REGISTRY_KEYS = ["source", "adapter", "ref", "path", "layout", "config"] as const;

export const ARTIFACT_KEYS = [
  "ref",
  "as",
  "exclude",
  "targets",
  LEGACY_TARGETS_KEY,
  "copy",
  "trust",
] as const;

export function emptyManifest(): Manifest {
  return {
    schema: undefined,
    name: undefined,
    description: undefined,
    engine: undefined,
    targets: [],
    registries: dict(),
    artifacts: [],
    exports: [],
    publish: undefined,
  };
}
