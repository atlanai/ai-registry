import type { WriteStream } from "node:tty";
import { sanitizeBlock } from "#adapter/text.ts";
import { isCI } from "./env.ts";

export type OutputFormat = "text" | "json";

export const COLOR_WHEN = ["auto", "always", "never"] as const;
export type ColorWhen = (typeof COLOR_WHEN)[number];

interface Writer {
  write(chunk: string): void;
  readonly isTTY: boolean;
}

/** Detect color per stream so redirected stdout does not disable stderr styling. */
export class Styler {
  readonly on: boolean;

  constructor(
    writer: { isTTY?: boolean },
    env: NodeJS.ProcessEnv = process.env,
    when: ColorWhen = "auto",
  ) {
    if (when !== "auto") {
      this.on = when === "always";
      return;
    }
    const forced = [env.FORCE_COLOR, env.CLICOLOR_FORCE].some(
      (value) => value !== undefined && value !== "" && value !== "0",
    );
    const terminal =
      writer.isTTY === true && env.TERM !== "dumb" && !isCI(env) && env.CLICOLOR !== "0";
    this.on = !env.NO_COLOR && (forced || terminal);
  }

  private wrap(open: string, text: string): string {
    // Styling nothing would make an empty cell look filled to a table.
    return this.on && text !== "" ? `\u001B[${open}m${text}\u001B[0m` : text;
  }

  bold(text: string): string {
    return this.wrap("1", text);
  }
  dim(text: string): string {
    return this.wrap("2", text);
  }
  red(text: string): string {
    return this.wrap("31", text);
  }
  green(text: string): string {
    return this.wrap("32", text);
  }
  yellow(text: string): string {
    return this.wrap("33", text);
  }
  cyan(text: string): string {
    return this.wrap("36", text);
  }

  /** `text` with every escape removed but the styling this writes: data in it could carry any other. */
  inert(text: string): string {
    return this.on ? ownStyleOnly(text) : sanitizeBlock(text);
  }
}

export interface PrinterOptions {
  out?: Writer;
  err?: Writer;
  format?: OutputFormat;
  verbose?: boolean;
  quiet?: boolean;
  color?: ColorWhen;
  env?: NodeJS.ProcessEnv;
}

const DIGEST = /^(sha256:)?[0-9a-f]{32,}$/i;

const ESC = "\u001B";
/** Exactly what `Styler` writes, so any other escape in a line can be told apart and dropped. */
const OWN_STYLE = new RegExp(`(${ESC}\\[(?:0|1|2|31|32|33|36)m)`);

/** `text` less every escape but those `Styler` writes, for a line styled before it is written. */
export function ownStyleOnly(text: string): string {
  const parts = text.split(OWN_STYLE);
  return parts.map((part, at) => (at % 2 === 1 ? part : sanitizeBlock(part))).join("");
}

/**
 * A revision is opaque: a commit, a snapshot id, an ordinal. Only something
 * that is plainly a digest is shortened, so `r3` and `v2.1.0` survive intact.
 */
export function abbreviate(revision: string): string {
  if (!DIGEST.test(revision)) return revision;
  return revision.replace(/^sha256:/i, "").slice(0, 7);
}

/** A fragment, or another program's own message, ended once as a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Primary output is never gated by `--verbose` or `--quiet`, and diagnostics never touch stdout.
 * Both carry manifest, registry and adapter text, so each is stripped of terminal escapes here, once.
 */
export class Printer {
  readonly format: OutputFormat;
  readonly verbose: boolean;
  readonly quiet: boolean;
  private readonly out: Writer;
  private readonly err: Writer;
  readonly style: Styler;
  readonly errStyle: Styler;
  // Whether a hint now would be about the warning or error just printed.
  private attached = false;
  private readonly options: PrinterOptions;

  constructor(options: PrinterOptions = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    this.out = options.out ?? (process.stdout as unknown as WriteStream);
    this.err = options.err ?? (process.stderr as unknown as WriteStream);
    this.format = options.format ?? "text";
    this.verbose = options.verbose ?? false;
    this.quiet = options.quiet ?? false;
    const color = options.color ?? "auto";
    this.style = new Styler(this.out, env, color);
    this.errStyle = new Styler(this.err, env, color);
  }

  /**
   * For a command run on this one's behalf: its one JSON result goes to `out` for the caller
   * to read, and its warnings and hints reach this printer's stderr as they are.
   */
  delegate(out: Writer): Printer {
    return new Printer({ ...this.options, err: this.err, out, format: "json" });
  }

  /** Whether stderr is a terminal, for notices a script reading stderr must not see. */
  get errIsTerminal(): boolean {
    return this.err.isTTY === true;
  }

  /** Only the styling this printer added survives: a manifest or registry could write any other escape. */
  private print(line: string): void {
    this.out.write(this.style.inert(line));
  }

  /** Primary output. Never suppressed. */
  info(message = ""): void {
    this.attached = false;
    if (this.format === "json") return;
    this.print(`${message}\n`);
  }

  success(message: string): void {
    this.attached = false;
    if (this.format === "json" || this.quiet) return;
    this.print(`${this.style.green("✓")} ${message}\n`);
  }

  /** A step in a longer operation. Verbose only. */
  step(message: string): void {
    this.attached = false;
    if (this.format === "json" || !this.verbose) return;
    this.err.write(`${this.errStyle.dim("·")} ${sanitizeBlock(message)}\n`);
  }

  /** Secondary information about the step just printed. Verbose only. */
  detail(message: string): void {
    this.attached = false;
    if (this.format === "json" || !this.verbose) return;
    this.err.write(`  ${this.errStyle.dim(sanitizeBlock(message))}\n`);
  }

  /** A labeled follow-up, such as the next command to run. */
  note(label: string, message: string): void {
    this.attached = false;
    if (this.format === "json" || this.quiet) return;
    this.print(`  ${this.style.dim(label.padEnd(5))}  ${message}\n`);
  }

  warning(message: string): void {
    this.err.write(`${this.errStyle.yellow("warning:")} ${sanitizeBlock(message)}\n`);
    this.attached = true;
  }

  error(message: string): void {
    this.err.write(`${this.errStyle.red("error:")} ${sanitizeBlock(message)}\n`);
    this.attached = true;
  }

  /** What to do about the error or warning just printed. */
  hint(message: string): void {
    if (this.quiet && !this.attached) return;
    this.err.write(`${this.errStyle.cyan("hint:")} ${sanitizeBlock(message)}\n`);
  }

  /** One envelope shape for every command, so callers branch on `ok` alone. */
  json(payload: {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string; hint?: string; adapter?: string; trace?: string };
  }): void {
    this.out.write(`${JSON.stringify(payload)}\n`);
  }

  /** A labeled diagnostic on stderr (problem code, trace). */
  field(label: string, value: string): void {
    this.err.write(`  ${this.errStyle.dim(`${label}:`)} ${sanitizeBlock(value)}\n`);
  }
}
