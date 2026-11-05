import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { onTestFinished, vi } from "vitest";
import type { PromptIo } from "#cli/prompt/model.ts";
import { CSI_BODY, ESC } from "#core/term/format.ts";

// Under CI, where prompts never run, Ink draws only a final frame; it reads
// the flag once, on first import, so it is cleared before then.
Reflect.deleteProperty(process.env, "CI");
Reflect.deleteProperty(process.env, "CONTINUOUS_INTEGRATION");
// Without a size, Ink runs `tput` for every frame it draws.
process.env.COLUMNS = "80";
process.env.LINES = "24";

export const KEY = {
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  enter: "\r",
  space: " ",
  escape: "\u001B",
  ctrlC: "\u0003",
  backspace: "\u007F",
} as const;

/** Stands in for a terminal's stdin, and records what raw mode was left in. */
class FakeInput extends PassThrough {
  isTTY = true;
  raw = false;

  setRawMode(on: boolean): this {
    this.raw = on;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** A screen buffer that applies the few control sequences the prompts write. */
class Screen {
  rows: string[][] = [[]];
  y = 0;
  x = 0;

  control(body: string): void {
    const command = body.at(-1);
    const count = Number.parseInt(body, 10) || 1;
    if (command === "A") this.y = Math.max(0, this.y - count);
    else if (command === "G") this.x = 0;
    else if (command === "K") this.rows[this.y] = [];
    else if (command === "J") this.rows.splice(this.y + 1);
  }

  put(char: string): void {
    if (char === "\n") {
      this.y += 1;
      this.x = 0;
      this.rows[this.y] ??= [];
    } else if (char === "\r") this.x = 0;
    else {
      const row = this.rows[this.y] ?? [];
      row[this.x] = char;
      this.rows[this.y] = row;
      this.x += 1;
    }
  }
}

/** The rows a terminal shows after `output`: cursor moves and erases applied, styling dropped. */
function screen(output: string): string[] {
  const shown = new Screen();
  let rest = output;
  while (rest !== "") {
    const body = rest.startsWith(`${ESC}[`) ? CSI_BODY.exec(rest.slice(2))?.[0] : undefined;
    if (body !== undefined) {
      shown.control(body);
      rest = rest.slice(2 + body.length);
      continue;
    }
    const char = [...rest][0] ?? "";
    rest = rest.slice(char.length);
    shown.put(char);
  }
  const lines = shown.rows.map((row) => stripVTControlCharacters(row.join("")).trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Resolves once the prompt reads keys; the first prompt in a file waits for Ink to load. */
async function reading(input: FakeInput): Promise<void> {
  if (input.listenerCount("readable") > 0) return;
  // Not a faked timer: the frozen clock would never end the wait.
  const signal = AbortSignal.timeout(10_000);
  let added: ((event: string | symbol) => void) | undefined;
  let late: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      added = (event) => {
        if (event === "readable") resolve();
      };
      late = () => reject(new Error("The prompt is not reading keys."));
      input.on("newListener", added);
      signal.addEventListener("abort", late);
    });
  } finally {
    if (added !== undefined) input.off("newListener", added);
    if (late !== undefined) signal.removeEventListener("abort", late);
  }
}

export interface Terminal {
  io: PromptIo;
  input: FakeInput;
  /** Waits for the prompt to read keys, types them one read each, then draws the frame they leave. */
  press(...keys: string[]): Promise<void>;
  screen(): string[];
  written(): string;
}

export function terminal(rows = 40, columns = 80): Terminal {
  // Ink throttles frames on a timer, so the clock is faked: a press then flushes the
  // trailing frame at once instead of sleeping past the interval and hoping it landed.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const input = new FakeInput();
  let written = "";
  const io: PromptIo = {
    input: input as unknown as NodeJS.ReadStream,
    output: {
      isTTY: true,
      write(chunk: string) {
        written += chunk;
      },
      columns,
      rows,
    },
  };
  return {
    io,
    input,
    async press(...keys) {
      await reading(input);
      for (const key of keys) {
        input.write(key);
        await tick();
      }
      await vi.runAllTimersAsync();
    },
    screen: () => screen(written),
    written: () => written,
  };
}
