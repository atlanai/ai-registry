import type { Artifact } from "../contract.ts";
import type { LayoutId } from "./ids.ts";
import type { Tree } from "./tree.ts";

/** A plugin a marketplace lists by where to fetch it, rather than by a folder inside it. */
export interface RemotePlugin {
  /** The plugin's name in the marketplace. */
  name: string;
  /** `github`, `url` or `git-subdir`. */
  type: string;
  /** `owner/repo` for github, a git URL otherwise. */
  location: string;
  /** The folder in the repository that holds the plugin, for git-subdir. */
  path: string | undefined;
  ref: string | undefined;
  /** A full commit, which wins over `ref`. */
  sha: string | undefined;
}

/** A remote plugin fetched to a folder on disk, at the commit it was read at. */
export interface FetchedPlugin {
  /** The plugin's folder, read as a tree of its own. */
  root: string;
  revision: string;
  /** Its version in its own repository: a tag on the commit, or a pseudo-version. */
  version: string | undefined;
}

/** What a layout is told about the source it reads. */
export interface LayoutContext {
  /** The namespace an artifact is listed under when the layout gives it none: the registry's name. */
  namespace: string;
  /** What to call the source when it is one artifact on its own, such as a lone SKILL.md. */
  rootName: string;
  /** Fetches a plugin listed by where it lives; absent, such a plugin is skipped. */
  fetch?: ((plugin: RemotePlugin) => Promise<FetchedPlugin>) | undefined;
  /** Whether a plugin the marketplace lists is asked for, by its entry's name; absent, all are. */
  asked?: ((name: string) => boolean) | undefined;
}

/** What a layout found, and what it left out. */
export interface Found {
  /** Sorted by id, each with a content-only envelope. */
  artifacts: Artifact[];
  /** One sentence each, such as a link that was skipped. */
  warnings: string[];
  /** What the source calls itself, such as a marketplace's name. */
  name?: string | undefined;
  /** By artifact id, the folder it is read from, where that is not the source's root. */
  roots?: Map<string, string> | undefined;
}

/** One way a source can lay out what it holds. */
export interface Layout {
  id: LayoutId;
  /** The files it reads a source by, for a source where no layout matched. */
  looksFor: readonly string[];
  /** "no" lets the next layout try. A manifest that is there but broken throws, which stops detection. */
  match(tree: Tree): Promise<"yes" | "no">;
  enumerate(tree: Tree, context: LayoutContext): Promise<Found>;
}
