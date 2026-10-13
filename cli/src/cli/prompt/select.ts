import type { Styler } from "#core/output.ts";
import { displayWidth } from "#core/term/format.ts";
import { GLYPH } from "#core/term/theme.ts";
import { footerLines, type Mark, railLine, titleLine } from "./layout.ts";
import {
  ask,
  CANCEL,
  type Canceled,
  type Keypress,
  type Machine,
  type PromptIo,
} from "./prompt.ts";

interface Option<T> {
  value: T;
  label: string;
  /** Why someone would pick this one. Shown beside the label. */
  hint?: string | undefined;
  /** Shown as the answer once chosen, when the label carries more, such as "(recommended)". */
  answer?: string | undefined;
  /** A letter that moves to this option, so `n` then enter answers No. */
  key?: string | undefined;
}

export interface SelectOptions<T> {
  message: string;
  options: readonly Option<T>[];
  style: Styler;
  /** Pre-selected value; the first option when it matches nothing. */
  initial?: T | undefined;
  /** What the question is about, under its title; kept under the answer once given. */
  body?: readonly string[] | undefined;
}

/** One answer from a short list; the cursor is the answer, so it wraps at either end. */
class Choosing<T> implements Machine<T> {
  private readonly options: SelectOptions<T>;
  private cursor: number;
  private ended: Mark = "active";

  constructor(options: SelectOptions<T>) {
    this.options = options;
    this.cursor = Math.max(
      0,
      options.options.findIndex((option) => option.value === options.initial),
    );
  }

  press(key: Keypress): { answer: T | Canceled } | undefined {
    if (this.ended !== "active") return undefined;
    const all = this.options.options;
    if (key.cancel) {
      this.ended = "cancel";
      return { answer: CANCEL };
    }
    const chosen = all[this.cursor];
    if (key.enter && chosen !== undefined) {
      this.ended = "submit";
      return { answer: chosen.value };
    }
    if (key.up) this.cursor = (this.cursor - 1 + all.length) % all.length;
    else if (key.down) this.cursor = (this.cursor + 1) % all.length;
    else if (key.text !== "" && !key.modified) {
      const letter = key.text.toLowerCase();
      const at = all.findIndex((option) => option.key?.toLowerCase() === letter);
      if (at !== -1) this.cursor = at;
    }
    return undefined;
  }

  lines(): string[] {
    const { style, message, options } = this.options;
    if (this.ended === "cancel")
      return [titleLine(style, "cancel", message, style.dim("canceled"))];
    const body = (this.options.body ?? []).map((line) => railLine(style, line));
    if (this.ended === "submit") {
      return [
        titleLine(style, "submit", message, style.dim(answerOf(options[this.cursor]))),
        ...body,
      ];
    }
    const letters = options.flatMap((option) => (option.key === undefined ? [] : [option.key]));
    const keys =
      letters.length > 0
        ? [letters.join("/"), `${GLYPH.upDown} choose`, "enter confirm", "esc cancel"]
        : [`${GLYPH.upDown} move`, "enter confirm", "esc cancel"];
    // Hints line up in one column, after the longest label.
    const widest = Math.max(...options.map((option) => displayWidth(option.label)));
    return [
      titleLine(style, "active", message),
      ...(body.length > 0 ? [...body, railLine(style)] : [railLine(style)]),
      ...options.map((option, index) => {
        const on = index === this.cursor;
        const radio = on ? style.green(GLYPH.bullet) : style.dim(GLYPH.hollow);
        const label = on ? style.cyan(option.label) : option.label;
        const pad = " ".repeat(widest - displayWidth(option.label) + 2);
        const hint = option.hint === undefined ? "" : `${pad}${style.dim(option.hint)}`;
        return railLine(style, `${radio} ${label}${hint}`);
      }),
      railLine(style),
      ...footerLines(style, keys),
    ];
  }
}

function answerOf<T>(option: Option<T> | undefined): string {
  return option?.answer ?? option?.label ?? "";
}

export async function select<T>(options: SelectOptions<T>, io: PromptIo): Promise<T | Canceled> {
  return await ask(io, new Choosing(options));
}

export interface ConfirmOptions {
  message: string;
  style: Styler;
  initial?: boolean | undefined;
  body?: readonly string[] | undefined;
}

/** Yes/no as a two-option select, so it looks and steers like every other prompt. */
export async function confirm(options: ConfirmOptions, io: PromptIo): Promise<boolean | Canceled> {
  return await select<boolean>(
    {
      message: options.message,
      style: options.style,
      initial: options.initial ?? true,
      body: options.body,
      options: [
        { value: true, label: "Yes", key: "y" },
        { value: false, label: "No", key: "n" },
      ],
    },
    io,
  );
}
