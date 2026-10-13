import { isActive, isFailed, type RunState } from "#core/run/model.ts";

/** One palette, so a state reads the same color in every view. */
export const COLOR = {
  white: "#f4f4f6",
  ink: "#d7d7dd",
  dim: "#8a8a96",
  faint: "#5a5a66",
  orange: "#e8875a",
  blue: "#7aa2f7",
  green: "#7fc8a0",
  red: "#e06c5c",
  yellow: "#e0c188",
  purple: "#c0a0e8",
  selection: "#1e2430",
} as const;

export const GLYPH = {
  ok: "✓",
  edited: "~",
  failed: "✗",
  pending: "⧗",
  imported: "↑",
  unpublished: "◦",
  duplicate: "◌",
  dangling: "⚠",
  missing: "?",
  folded: "▸",
  open: "▾",
  branch: "├─",
  last: "└─",
  // The picker's softer tree; the console keeps its own above.
  twig: "├╴",
  twigLast: "╰╴",
  bullet: "●",
  hollow: "○",
  dot: "•",
  active: "◆",
  submit: "◇",
  cancel: "■",
  end: "└",
  rule: "─",
  partial: "◐",
  locked: "✓",
  cursor: "❯",
  pipe: "│",
  arrow: "→",
  upDown: "↑↓",
  caret: "▌",
  leftRight: "←→",
  aside: "↳",
  sep: "·",
  spin: "⟳",
} as const;

export function runColor(state: RunState): string {
  if (state === "succeeded") return COLOR.green;
  if (isActive(state)) return COLOR.blue;
  if (isFailed(state)) return COLOR.red;
  return COLOR.yellow;
}

export function runGlyph(state: RunState): string {
  if (state === "succeeded") return GLYPH.ok;
  if (isActive(state)) return GLYPH.spin;
  if (isFailed(state)) return GLYPH.failed;
  return "!";
}
