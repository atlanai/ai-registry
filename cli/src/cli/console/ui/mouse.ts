import { useStdin, useStdout } from "ink";
import { useEffect, useRef } from "react";
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

/**
 * The first rendered row of a list, per view. A contributed panel states its own,
 * because only it knows how many rows it puts above its list.
 */
export function listTop(view: string, panelTop?: number): number | undefined {
  // Artifacts: the filter, a blank, then the column heading.
  if (view === "artifacts") return LAYOUT.body + 3;
  // Jobs: the JOBS heading, the jobs themselves, then a blank and RUNS.
  if (view === "jobs") return LAYOUT.body + 1;
  return panelTop;
}

/** Jobs stacks two lists; a click past the first one lands in the second. */
export function jobsIndexAt(row: number, jobCount: number, firstRun: number): number | undefined {
  const top = LAYOUT.body + 1;
  if (row < top) return undefined;
  const offset = row - top;
  if (offset < jobCount) return offset;
  // Two rows of heading sit between the jobs and the runs.
  const runOffset = offset - jobCount - 2;
  return runOffset < 0 ? undefined : jobCount + firstRun + runOffset;
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
