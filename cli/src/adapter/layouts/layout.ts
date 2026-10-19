import type { Artifact } from "../contract.ts";
import type { LayoutId } from "./ids.ts";
import type { Tree } from "./tree.ts";

/** What a layout is told about the source it reads. */
export interface LayoutContext {
  /** The namespace an artifact is listed under when the layout gives it none: the registry's name. */
  namespace: string;
  /** What to call the source when it is one artifact on its own, such as a lone SKILL.md. */
  rootName: string;
}

/** What a layout found, and what it left out. */
export interface Found {
  /** Sorted by id, each with a content-only envelope. */
  artifacts: Artifact[];
  /** One sentence each, such as a link that was skipped. */
  warnings: string[];
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
