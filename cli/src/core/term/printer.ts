import type { WriteStream } from "node:tty";
import { sanitizeBlock } from "#adapter/text.ts";
import { isCI } from "#core/env.ts";
import { GLYPH } from "./theme.ts";

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

  /** Drops every escape but this styler's own, since data could carry any other. */
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

/** For a line styled before it is written. */
export function ownStyleOnly(text: string): string {
  const parts = text.split(OWN_STYLE);
  return parts.map((part, at) => (at % 2 === 1 ? part : sanitizeBlock(part))).join("");
}

/** A revision is opaque; only a plain digest is shortened, so `r3` and `v2.1.0` survive. */
export function abbreviate(revision: string): string {
  if (!DIGEST.test(revision)) return revision;
  return revision.replace(/^sha256:/i, "").slice(0, 7);
}

export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Primary output ignores `--verbose` and `--quiet`; diagnostics never touch stdout. Both strip
 * escapes here, since they carry manifest, registry and adapter text. */
export class Printer {
  readonly format: OutputFormat;
  readonly verbose: boolean;
  readonly quiet: boolean;
  private readonly out: Writer;
  private readonly err: Writer;
  readonly style: Styler;
  readonly errStyle: Styler;
  private followsProblem = false;
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

  /** For a command run on this one's behalf: its JSON goes to `out`, its warnings to this stderr. */
  delegate(out: Writer): Printer {
    return new Printer({ ...this.options, err: this.err, out, format: "json" });
  }

  /** For notices a script reading stderr must not see. */
  get errIsTerminal(): boolean {
    return this.err.isTTY === true;
  }

  /** A manifest or registry could write any escape, so only this printer's styling stays. */
  private print(line: string): void {
    this.out.write(this.style.inert(line));
  }

  info(message = ""): void {
    this.followsProblem = false;
    if (this.format === "json") return;
    this.print(`${message}\n`);
  }

  success(message: string): void {
    this.followsProblem = false;
    if (this.format === "json" || this.quiet) return;
    this.print(`${this.style.green(GLYPH.ok)} ${message}\n`);
  }

  /** Closes a dry run, whose report otherwise reads like the real run's. */
  dryRun(): void {
    this.info(this.style.dim("Dry run. Nothing was changed."));
  }

  /** Verbose only. */
  step(message: string): void {
    this.followsProblem = false;
    if (this.format === "json" || !this.verbose) return;
    this.err.write(`${this.errStyle.dim("·")} ${sanitizeBlock(message)}\n`);
  }

  /** About the step just printed. Verbose only. */
  detail(message: string): void {
    this.followsProblem = false;
    if (this.format === "json" || !this.verbose) return;
    this.err.write(`  ${this.errStyle.dim(sanitizeBlock(message))}\n`);
  }

  note(label: string, message: string): void {
    this.followsProblem = false;
    if (this.format === "json" || this.quiet) return;
    this.print(`  ${this.style.dim(label.padEnd(5))}  ${message}\n`);
  }

  warning(message: string): void {
    this.err.write(`${this.errStyle.yellow("warning:")} ${sanitizeBlock(message)}\n`);
    this.followsProblem = true;
  }

  error(message: string): void {
    this.err.write(`${this.errStyle.red("error:")} ${sanitizeBlock(message)}\n`);
    this.followsProblem = true;
  }

  hint(message: string): void {
    if (this.quiet && !this.followsProblem) return;
    this.err.write(`${this.errStyle.cyan("hint:")} ${sanitizeBlock(message)}\n`);
  }

  /** Shown in every format: it goes to stderr, so `--json` output stays clean. */
  notice(message: string): void {
    this.followsProblem = false;
    this.err.write(`${this.errStyle.bold("notice:")} ${sanitizeBlock(message)}\n`);
  }

  /** One envelope shape for every command, so callers branch on `ok` alone. */
  json(payload: {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string; hint?: string; adapter?: string; trace?: string };
  }): void {
    this.out.write(`${JSON.stringify(payload)}\n`);
  }

  field(label: string, value: string): void {
    this.err.write(`  ${this.errStyle.dim(`${label}:`)} ${sanitizeBlock(value)}\n`);
  }
}
