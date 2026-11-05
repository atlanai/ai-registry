import type { ArtifactKind } from "#adapter/kinds.ts";
import type { LayoutId } from "#adapter/layouts/ids.ts";
import type { Scope } from "#core/store/paths.ts";

export interface DeclaredRegistry {
  registry: string;
  /** Without credentials. */
  address: string;
  /** Absent when aireg asks each adapter whether it recognizes the address. */
  adapter?: string;
  config: Record<string, string>;
}

/** `movedFrom` and `kept` are set only when the name moved. */
export interface RegistryAdded extends DeclaredRegistry {
  movedFrom?: string;
  kept?: number;
  /** False when the registry could not be read before you sign in. */
  readable: boolean;
  dryRun: boolean;
}

export interface RegistryList {
  scope: Scope;
  registries: DeclaredRegistry[];
}

export interface PublishedArtifact {
  name: string;
  kind: ArtifactKind;
  namespace?: string;
  path: string;
  description?: string;
  /** The oldest aireg that can install it. */
  engine?: string;
  /** The version the registry serves, which `@<version>` pins. */
  version?: string;
}

export interface RegistryShown {
  registry: string;
  address: string;
  /** The commit read, for a git registry. */
  revision?: string;
  /** Only for a source that is not a registry. */
  layout?: LayoutId;
  layouts: string[];
  entries: PublishedArtifact[];
  warnings: string[];
}

export interface RegistryRemoved {
  registry: string;
  dryRun: boolean;
  /** The ids of the jobs removed with it, or under `dryRun` that would be. */
  jobs: string[];
}

/** In an existing registry, `namespaces` holds only the ones added. */
export interface RegistryCreated {
  root: string;
  created: boolean;
  slug: string;
  namespaces: string[];
}

/** A version indexed, or one whose artifact's `latest` moved. */
export interface IndexedVersion {
  namespace: string;
  kind: ArtifactKind;
  name: string;
  version: string;
  digest: string;
  description?: string;
  status?: string;
  catalogDigest?: string;
}

export interface RegistryIndexed {
  root: string;
  added: IndexedVersion[];
  moved: IndexedVersion[];
  /** Root-relative paths written. */
  paths: string[];
}

export interface RegistryProblem {
  path: string;
  message: string;
  fix?: string;
}

export interface RegistryValidated {
  name: string;
  namespaces: number;
  artifacts: number;
  versions: number;
  problems: RegistryProblem[];
  warnings: string[];
}
