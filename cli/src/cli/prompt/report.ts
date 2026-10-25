import { sanitizeText } from "#adapter/text.ts";
import { isCI } from "#core/env.ts";
import type { Styler } from "#core/output.ts";
import { displayWidth } from "#core/term/format.ts";
import { GLYPH } from "#core/term/theme.ts";
import type { PromptIo, PromptWriter } from "./prompt.ts";

// The non-interactive parts of the prompt frame. Both write to the prompt's
// stream, never to stdout, so a redirected stdout still holds only results.

/** A framed block of already-formatted lines under a title. */
export function note(io: PromptIo, style: Styler, title: string, body: readonly string[]): void {
  const width = Math.max(
    displayWidth(title) + 2,
    ...body.map((line) => displayWidth(line) + 2),
    24,
  );
  const bar = style.dim(GLYPH.pipe);
  const lines = [
    `${style.green(GLYPH.submit)}  ${style.bold(title)}`,
    ...body.map((line) => `${bar}  ${line}`),
    style.dim(GLYPH.end + GLYPH.rule.repeat(Math.min(width, 60))),
  ];
  io.output.write(style.inert(`${lines.join("\n")}\n`));
}

const FRAMES = ["◒", "◐", "◓", "◑"] as const;
const INTERVAL_MS = 120;

export interface Spinner {
  update(message: string): void;
  stop(message?: string): void;
}

/** Redraws in place, so callers start one only where `canAnimate` says a terminal is watching. */
export function spinner(io: PromptIo, style: Styler): Spinner {
  const write = (chunk: string): void => {
    io.output.write(chunk);
  };
  let message = "";
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const paint = (): void => {
    write(`\u001B[2K\r${style.cyan(FRAMES[frame % FRAMES.length] as string)} ${message}`);
    frame += 1;
  };

  return {
    update(next) {
      message = sanitizeText(next);
      if (timer === undefined) {
        paint();
        timer = setInterval(paint, INTERVAL_MS);
        timer.unref();
      }
    },
    stop(final) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      write("\u001B[2K\r");
      if (final !== undefined) write(`${style.green(GLYPH.submit)}  ${sanitizeText(final)}\n`);
    },
  };
}

export function canAnimate(output: PromptWriter, env: NodeJS.ProcessEnv = process.env): boolean {
  return (output as { isTTY?: boolean }).isTTY === true && env.TERM !== "dumb" && !isCI(env);
}
