import type { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Key, render, Text, useApp, useInput } from "ink";
import { createElement, type ReactElement, useEffect, useReducer, useState } from "react";
import { CSI_BODY, cells, ESC } from "#core/term/format.ts";
import { wrapRows } from "./layout.ts";
import {
  CANCEL,
  type Canceled,
  type Keypress,
  type Machine,
  type PromptIo,
  type PromptWriter,
  type Size,
} from "./prompt.ts";

const DEFAULT_COLUMNS = 80;

function sizeOf(output: PromptWriter): Size {
  const columns = output.columns !== undefined && output.columns > 0 ? output.columns : undefined;
  const rows = output.rows !== undefined && output.rows > 0 ? output.rows : undefined;
  return { columns: columns ?? DEFAULT_COLUMNS, rows };
}

function useSize(output: PromptWriter): Size {
  const [size, setSize] = useState(() => sizeOf(output));
  useEffect(() => {
    const source = output as Partial<Pick<EventEmitter, "on" | "off">>;
    if (typeof source.on !== "function") return;
    const resized = (): void => setSize(sizeOf(output));
    source.on.call(output, "resize", resized);
    return () => {
      source.off?.call(output, "resize", resized);
    };
  }, [output]);
  return size;
}

function keypress(text: string, key: Key): Keypress {
  return {
    text,
    up: key.upArrow,
    down: key.downArrow,
    left: key.leftArrow,
    right: key.rightArrow,
    enter: key.return,
    cancel: key.escape || (key.ctrl && text === "c"),
    erase: key.backspace || key.delete,
    modified: key.ctrl || (key.meta && !key.escape),
  };
}

/**
 * Lines measured here, one Text per terminal row: a long line breaks where the
 * terminal would, and Ink erases every row it drew on the next frame.
 */
function Frame(props: { lines: readonly string[]; columns: number }): ReactElement {
  const rows = props.lines.flatMap((line) => wrapRows(line, props.columns));
  return createElement(
    Box,
    { flexDirection: "column" },
    // An empty Text takes no height, so a blank row keeps one cell.
    ...rows.map((row, index) => createElement(Text, { key: index }, row === "" ? " " : row)),
  );
}

interface PromptProps<T> {
  machine: Machine<T>;
  output: PromptWriter;
  settle(answer: T | Canceled): void;
}

/**
 * The machine holds the state, so keys read in one burst all see the latest
 * of it. Ink unmounts on the commit after the answer, leaving that frame behind.
 */
function Prompt<T>(props: PromptProps<T>): ReactElement {
  const { exit } = useApp();
  const size = useSize(props.output);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [done, setDone] = useState(false);
  useInput((text, key) => {
    const outcome = props.machine.press(keypress(text, key));
    redraw();
    if (outcome === undefined) return;
    props.settle(outcome.answer);
    setDone(true);
  });
  useEffect(() => {
    if (done) exit();
  }, [done, exit]);
  return createElement(Frame, { lines: props.machine.lines(size), columns: size.columns });
}

/**
 * Ink's view of the prompt stream. It has no height on purpose: frames are
 * fitted before they reach Ink, which clears the whole terminal once one fills it.
 */
class Output extends Writable {
  readonly target: PromptWriter;

  constructor(target: PromptWriter) {
    super();
    this.target = target;
  }

  get columns(): number {
    return sizeOf(this.target).columns;
  }

  get isTTY(): boolean {
    return this.target.isTTY === true;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ): void {
    try {
      this.target.write(chunk.toString());
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Prompt output failed."));
      return;
    }
    callback();
  }
}

/** Ink names forward delete as it names backspace, and no prompt has a cursor to delete forward from. */
const FORWARD_DELETE = `${ESC}[3~`;

/** The key `rest` opens with: an escape sequence whole, with or without alt, else one character. */
function firstKey(rest: string): string {
  if (!rest.startsWith(ESC)) return cells(rest)[0]?.text ?? rest;
  const lead = rest.startsWith(ESC + ESC) ? 2 : 1;
  const body = rest.slice(lead);
  if (body.startsWith("[")) {
    const params = CSI_BODY.exec(body.slice(1))?.[0];
    if (params !== undefined) return rest.slice(0, lead + 1 + params.length);
  }
  const next = [...body.slice(body.startsWith("O") ? 1 : 0)][0];
  if (next === undefined || next === ESC) return rest.slice(0, lead);
  return rest.slice(0, lead + (body.startsWith("O") ? 1 : 0) + next.length);
}

/** A read can hold several keys, and Ink takes each read as one, so they are handed over singly. */
function split(chunk: string): string[] {
  const out: string[] = [];
  let rest = chunk;
  while (rest !== "") {
    const key = firstKey(rest);
    if (key !== FORWARD_DELETE) out.push(key);
    rest = rest.slice(key.length);
  }
  return out;
}

type Handle = Partial<{ ref(): unknown; unref(): unknown }>;

/**
 * Ink reads keys only in raw mode, so it is told the input is a terminal; raw
 * mode itself is switched only on a real one.
 */
function keyed(input: NodeJS.ReadStream): NodeJS.ReadStream {
  const queue: string[] = [];
  const handle = input as Handle;
  const adapter = {
    isTTY: true,
    setEncoding() {
      input.setEncoding("utf8");
      return adapter;
    },
    setRawMode(on: boolean) {
      if (input.isTTY === true) input.setRawMode(on);
      return adapter;
    },
    ref() {
      handle.ref?.call(input);
      return adapter;
    },
    unref() {
      handle.unref?.call(input);
      return adapter;
    },
    addListener(event: string, listener: () => void) {
      input.addListener(event, listener);
      return adapter;
    },
    removeListener(event: string, listener: () => void) {
      input.removeListener(event, listener);
      return adapter;
    },
    read(): string | null {
      if (queue.length === 0) {
        const chunk = input.read() as string | Buffer | null;
        if (chunk !== null) queue.push(...split(String(chunk)));
      }
      return queue.shift() ?? null;
    },
  };
  return adapter as unknown as NodeJS.ReadStream;
}

/** Draws the machine inline until it answers, leaving its last frame in the scrollback. */
export async function mount<T>(io: PromptIo, machine: Machine<T>): Promise<T | Canceled> {
  let answer: T | Canceled = CANCEL;
  const output = new Output(io.output);
  const prompt = Prompt as (props: PromptProps<T>) => ReactElement;
  const props: PromptProps<T> = {
    machine,
    output: io.output,
    settle: (value) => {
      answer = value;
    },
  };
  const app = render(createElement(prompt, props), {
    stdin: keyed(io.input),
    stdout: output,
    stderr: output,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await app.waitUntilExit();
  return answer;
}
