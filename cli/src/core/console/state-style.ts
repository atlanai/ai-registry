import { COLOR, GLYPH } from "#core/term/theme.ts";
import type { ArtifactState } from "./model.ts";

const STATE_STYLE: Record<ArtifactState, { glyph: string; color: string }> = {
  ok: { glyph: GLYPH.ok, color: COLOR.green },
  edited: { glyph: GLYPH.edited, color: COLOR.yellow },
  failed: { glyph: GLYPH.failed, color: COLOR.red },
  pending: { glyph: GLYPH.pending, color: COLOR.yellow },
  imported: { glyph: GLYPH.imported, color: COLOR.green },
  unpublished: { glyph: GLYPH.unpublished, color: COLOR.dim },
  duplicate: { glyph: GLYPH.duplicate, color: COLOR.faint },
  dangling: { glyph: GLYPH.dangling, color: COLOR.orange },
  missing: { glyph: GLYPH.missing, color: COLOR.orange },
};

export function stateStyle(state: ArtifactState): { glyph: string; color: string } {
  return STATE_STYLE[state];
}

/** The terminal has four tones, so the panel palette folds onto them here. */
export function stateTone(state: ArtifactState): "green" | "yellow" | "red" | "dim" {
  const { color } = STATE_STYLE[state];
  if (color === COLOR.green) return "green";
  if (color === COLOR.red) return "red";
  return color === COLOR.yellow || color === COLOR.orange ? "yellow" : "dim";
}

export const STATE_MEANING: Record<ArtifactState, string> = {
  ok: "matches the lockfile, links intact",
  edited: "you edited it after installing it",
  failed: "the registry would not serve it",
  pending: "published, waiting for review upstream",
  imported: "authored here, and a job already carries it into your account",
  unpublished: "authored here, never sent",
  duplicate: "an artifact of this name is installed here; this folder is a separate copy",
  dangling: "a link is not ours, or points outside the tree",
  missing: "not fetched into this project",
};
