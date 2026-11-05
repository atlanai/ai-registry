/** Answered on escape, ctrl+c, or when there is nothing to choose. */
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
  /** Stderr, so prompts never land in `aireg list --json | jq` or a redirected stdout. */
  output: PromptWriter;
}

export interface Size {
  columns: number;
  /** Undefined when the height is unknown, meaning the frame is not fitted to it. */
  rows: number | undefined;
}

export interface Keypress {
  /** Empty for a named key. */
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

export interface Machine<T> {
  press(key: Keypress): { answer: T | Canceled } | undefined;
  lines(size: Size): string[];
}
