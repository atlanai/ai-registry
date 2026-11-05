import { useStdin, useStdout } from "ink";
import { useEffect, useRef } from "react";
import { windowAround } from "#cli/console/data/list.ts";
import { ESC } from "#core/term/format.ts";

// SGR (1006) reporting, which Ink lacks: the older encoding cannot express a column past 223.
const ENABLE = `${ESC}[?1000h${ESC}[?1006h`;
const DISABLE = `${ESC}[?1006l${ESC}[?1000l`;

/** `ESC [ < button ; column ; row M|m` - 1-based, M is press, m is release. */
const SGR = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");

export interface MouseEvent {
  /** 0-based, so it indexes rendered lines directly. */
  row: number;
  column: number;
  kind: "press" | "release" | "wheel-up" | "wheel-down";
}

export function useMouse(onEvent: (event: MouseEvent) => void): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  // Held in a ref so the handler can close over this render's state without
  // the subscription tearing down and re-arming the terminal on every one.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!isRawModeSupported || stdin === undefined) return;
    setRawMode(true);
    stdout.write(ENABLE);

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      SGR.lastIndex = 0;
      for (let match = SGR.exec(text); match !== null; match = SGR.exec(text)) {
        const kind = decode(Number(match[1]), match[4] as string);
        if (kind === undefined) continue;
        handler.current({ column: Number(match[2]) - 1, row: Number(match[3]) - 1, kind });
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write(DISABLE);
      // Ink counts raw-mode requests, so one never handed back keeps the
      // terminal raw after everything else reading keys has let go.
      setRawMode(false);
    };
  }, [stdin, stdout, setRawMode, isRawModeSupported]);
}

function decode(button: number, final: string): MouseEvent["kind"] | undefined {
  if ((button & 64) !== 0) return (button & 1) === 0 ? "wheel-up" : "wheel-down";
  // Only the left button drives anything here; a drag is a press we ignore.
  if ((button & 3) !== 0 || (button & 32) !== 0) return undefined;
  return final === "M" ? "press" : "release";
}

/** Fixed: Ink does not expose the geometry a measured layout would need. */
export const LAYOUT = {
  accountTabs: 2,
  viewTabs: 4,
  body: 6,
} as const;

export function listRowAt(
  screenRow: number,
  list: { top: number; total: number; cursor: number; height: number },
): number | undefined {
  const window = windowAround(list.total, list.cursor, list.height);
  const index = window.from + (screenRow - list.top);
  return index >= window.from && index < window.to ? index : undefined;
}

/** Which tab a click at this column belongs to, given each label's width. */
export function tabAt(column: number, widths: readonly number[], gap: number): number | undefined {
  let start = 0;
  for (const [index, width] of widths.entries()) {
    if (column >= start && column < start + width) return index;
    start += width + gap;
  }
  return undefined;
}
