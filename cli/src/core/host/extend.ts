import type { SourceAdapter, SourceContext } from "#adapter/index.ts";
import type { Account, Step } from "#core/config/model.ts";
import type { ItemSettled, RunCounts, TerminalRunState } from "#core/run/model.ts";
import type { RunStore } from "#core/run/store.ts";
import type { KindMapping } from "#core/target/contract.ts";
import type { Printer } from "#core/term/printer.ts";
import type { PanelContribution, UpstreamContribution } from "./panel.ts";

export interface ExtensionHost {
  version: string;
  connectAccount(
    account: Account,
    alias: string,
    signal: AbortSignal,
  ): Promise<{ adapter: SourceAdapter; context: SourceContext }>;
  openRunStore(): Promise<RunStore>;
}

export interface HostCommandContext {
  argv: string[];
  cwd: string;
  printer: Printer;
  host: ExtensionHost;
  exit?: number;
}

export interface CommandContribution {
  name: string;
  aliases?: readonly string[];
  summary: string;
  group: string;
  actions?: readonly string[];
  usage?: readonly string[];
  /** For help and `--map` only; the command still parses its own argv. */
  options?: readonly OptionSpec[];
  examples?: readonly Example[];
  docs?: string;
  load: () => Promise<{ run: (context: HostCommandContext) => Promise<void> }>;
}

interface JobHooks {
  event(type: string, step: string, artifact?: string, data?: unknown): void;
  item(artifact: string, step: string, settled: ItemSettled, data?: unknown): void;
}

interface StepRunInput {
  step: Step;
  account: Account;
  store: RunStore;
  runId: string;
  version: string;
  signal: AbortSignal;
  hooks: JobHooks;
  host: ExtensionHost;
}

export interface StepRunResult {
  state: TerminalRunState;
  counts: RunCounts;
  errorCode?: string;
  retryable?: boolean;
}

export interface FlagSpec {
  type: "string" | "boolean";
  multiple?: boolean;
}

export interface OptionSpec {
  readonly flag: `--${string}`;
  readonly short?: `-${string}`;
  /** Set only on an option that takes a value; help prints it after the flag. */
  readonly value?: string;
  readonly multiple?: true;
  readonly choices?: readonly string[];
  /** The parser hands the value over as a number. */
  readonly integer?: { readonly min?: number; readonly max?: number };
  readonly describe: string;
}

export interface Example {
  readonly command: string;
  readonly what: string;
}

/** Kinds rather than job types: an adapter's step sits beside aireg's own in one graph. */
export interface StepContribution {
  kind: string;
  /** Without dashes: `probe` for `--probe`. */
  flag?: string;
  /** Extra `job add` options, which aireg never names. */
  options?: Readonly<Record<string, FlagSpec>>;
  /** Maps those options onto the fields a step of this kind carries. */
  params?(flags: Readonly<Record<string, unknown>>): Record<string, unknown>;
  run(input: StepRunInput): Promise<StepRunResult>;
  describe?(step: Step, registry: string): string;
  /** Keep the job on its interval when nothing changes, instead of backing off. */
  steady?: boolean;
}

/** A kind an adapter adds, as data: aireg stores, places and publishes it as its spec says. */
export interface KindContribution {
  /** The kind on the wire and in addresses, in the file spec's kind grammar `^[a-z][a-z0-9_]{0,31}$`. */
  name: string;
  /** Its folder, and its plural in messages: one path segment, such as `knowledge`. */
  dir: string;
  shape: "directory" | "file";
  /** Required for a file-shaped kind, such as `[".md"]`; absent for a directory. */
  extensions?: readonly string[];
  /** For a directory kind: the file that marks it and holds its front matter. Absent: any folder. */
  entry?: string;
  /** One line for help and search. */
  description?: string;
  /**
   * Where each target places it, by target id, in a target file's `directory` or `file` mapping.
   * A target left out does not load it; with no mapping anywhere the kind is publish-only.
   */
  targets?: Readonly<Record<string, KindMapping>>;
}

/**
 * Merged by the host at load so a new command is never a branch in the client.
 * Kept out of the published types.
 */
export interface AdapterExtension {
  commands?: readonly CommandContribution[];
  steps?: readonly StepContribution[];
  // biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
  panels?: readonly PanelContribution<any>[];
  upstream?: UpstreamContribution;
  /** Checked at load: a built-in's name or folder, or a bad entry, costs this adapter its kinds. */
  kinds?: readonly KindContribution[];
}

export function extensionOf(adapter: SourceAdapter): AdapterExtension | undefined {
  const extend: unknown = (adapter as { extend?: unknown }).extend;
  return typeof extend === "object" && extend !== null ? (extend as AdapterExtension) : undefined;
}
