/** What a prompt answers when the person backs out: escape, ctrl+c, or nothing to choose. */
export const CANCEL = Symbol("prompt.cancel");
export type Canceled = typeof CANCEL;

export function canceled<T>(value: T | Canceled): value is Canceled {
  return value === CANCEL;
}

export interface PromptWriter {
  write(chunk: string): void;
  readonly isTTY?: boolean;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

export interface PromptIo {
  input: NodeJS.ReadStream;
  /**
   * Prompts go to stderr. Interaction is not output: it must not land in
   * `aireg list --json | jq` or in a file the user redirected stdout to.
   */
  output: PromptWriter;
}

const nowhere: PromptWriter = { write: () => {} };
let silenced = false;

/** Runs `work` with every prompt and spinner writing nowhere, for commands run on another's behalf. */
export async function quietly<T>(work: () => Promise<T>): Promise<T> {
  silenced = true;
  try {
    return await work();
  } finally {
    silenced = false;
  }
}

export function defaultIo(): PromptIo {
  return { input: process.stdin, output: silenced ? nowhere : process.stderr };
}

export interface Size {
  columns: number;
  /** Undefined when the height is unknown, meaning the frame is not fitted to it. */
  rows: number | undefined;
}

export interface Keypress {
  /** The character typed, empty for a named key. */
  text: string;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  enter: boolean;
  /** Escape or ctrl+c. */
  cancel: boolean;
  /** Backspace, which most terminals send as delete. */
  erase: boolean;
  /** Ctrl or alt held, so `text` is not something typed. */
  modified: boolean;
}

/** A prompt's state: keys in, the frame to draw out, and an answer once it has one. */
export interface Machine<T> {
  press(key: Keypress): { answer: T | Canceled } | undefined;
  lines(size: Size): string[];
}

let renderer: Promise<typeof import("./mount.ts")> | undefined;

/**
 * Starts loading Ink, which a command that asks nothing never does. A command
 * that will ask calls this before slow work, so the prompt does not wait for it.
 */
export function prepare(): Promise<typeof import("./mount.ts")> {
  if (renderer === undefined) {
    renderer = import("./mount.ts");
    // Unawaited until the first prompt, if one comes; a failure surfaces there.
    renderer.catch(() => {});
  }
  return renderer;
}

export async function ask<T>(io: PromptIo, machine: Machine<T>): Promise<T | Canceled> {
  const { mount } = await prepare();
  return await mount(io, machine);
}
