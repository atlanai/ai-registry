import type { Artifact } from "../contract.ts";
import type { LayoutId } from "./ids.ts";
import type { Tree } from "./tree.ts";

/** A plugin a marketplace lists by where to fetch it, not by a folder inside it. */
export interface RemotePlugin {
  name: string;
  /** `github`, `url` or `git-subdir`. */
  type: string;
  /** `owner/repo` for github, a git URL otherwise. */
  location: string;
  /** For git-subdir. */
  path: string | undefined;
  ref: string | undefined;
  /** A full commit, which wins over `ref`. */
  sha: string | undefined;
}

export interface FetchedPlugin {
  root: string;
  revision: string;
  /** A tag on the commit, or a pseudo-version. */
  version: string | undefined;
}

export interface LayoutContext {
  /** For an artifact the layout gives none: the registry's name. */
  namespace: string;
  /** The name for a source that is one artifact, such as a lone SKILL.md. */
  rootName: string;
  /** Absent, a remote plugin is skipped. */
  fetch?: ((plugin: RemotePlugin) => Promise<FetchedPlugin>) | undefined;
  /** By the marketplace entry's name; absent, every plugin is asked for. */
  asked?: ((name: string) => boolean) | undefined;
}

export interface Found {
  /** Sorted by id, each with a content-only envelope. */
  artifacts: Artifact[];
  /** One sentence each. */
  warnings: string[];
  name?: string | undefined;
  /** By artifact id, where that is not the source's root. */
  roots?: Map<string, string> | undefined;
}

export interface Layout {
  id: LayoutId;
  /** Named in the message for a source no layout matched. */
  looksFor: readonly string[];
  /** "no" lets the next layout try; a present but broken manifest throws, stopping detection. */
  match(tree: Tree): Promise<"yes" | "no">;
  enumerate(tree: Tree, context: LayoutContext): Promise<Found>;
}
