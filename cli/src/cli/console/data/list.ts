import type { ListWindow } from "#core/host/panel.ts";

export function windowAround(total: number, cursor: number, height: number): ListWindow {
  const size = Math.max(1, height);
  if (total <= size) return { from: 0, to: total, above: 0, below: 0 };
  // Keep the cursor off the very edge so what comes next is always visible.
  const margin = Math.min(2, Math.floor(size / 3));
  let from = Math.min(Math.max(0, cursor - margin), total - size);
  from = Math.max(0, from);
  const to = Math.min(total, from + size);
  return { from, to, above: from, below: total - to };
}

export function step(cursor: number, delta: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(total - 1, Math.max(0, cursor + delta));
}
