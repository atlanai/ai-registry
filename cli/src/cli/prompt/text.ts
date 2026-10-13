import type { Styler } from "#core/output.ts";
import { cells } from "#core/term/format.ts";
import { GLYPH } from "#core/term/theme.ts";
import { type Mark, railLine, titleLine } from "./layout.ts";
import {
  ask,
  CANCEL,
  type Canceled,
  type Keypress,
  type Machine,
  type PromptIo,
} from "./prompt.ts";

export interface TextOptions {
  message: string;
  style: Styler;
  /** Taken when the answer is left empty, and shown until something is typed. */
  initial?: string | undefined;
  /** How to answer, shown under the question while it waits. */
  hint?: string | undefined;
}

const CONTROL = /\p{Cc}/gu;

class Typing implements Machine<string> {
  private readonly options: TextOptions;
  private value = "";
  private ended: Mark = "active";

  constructor(options: TextOptions) {
    this.options = options;
  }

  press(key: Keypress): { answer: string | Canceled } | undefined {
    if (this.ended !== "active") return undefined;
    if (key.cancel) {
      this.ended = "cancel";
      return { answer: CANCEL };
    }
    if (key.enter) {
      this.ended = "submit";
      return { answer: this.value.trim() || (this.options.initial ?? "") };
    }
    if (key.erase)
      this.value = cells(this.value)
        .slice(0, -1)
        .map((cell) => cell.text)
        .join("");
    else if (!key.modified) this.value += key.text.replace(CONTROL, "");
    return undefined;
  }

  lines(): string[] {
    const { style, message, initial = "", hint } = this.options;
    if (this.ended === "cancel")
      return [titleLine(style, "cancel", message, style.dim("canceled"))];
    if (this.ended === "submit") {
      return [titleLine(style, "submit", message, style.dim(this.value || initial))];
    }
    return [
      // Ink hides the terminal's cursor, so the prompt draws one where typing goes.
      titleLine(
        style,
        "active",
        message,
        this.value === "" ? `${GLYPH.caret}${style.dim(initial)}` : `${this.value}${GLYPH.caret}`,
      ),
      ...(hint === undefined ? [] : [railLine(style, style.dim(hint))]),
    ];
  }
}

export async function text(options: TextOptions, io: PromptIo): Promise<string | Canceled> {
  return await ask(io, new Typing(options));
}
