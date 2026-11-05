import type { SourceAdapter, SourceContext } from "#adapter/index.ts";
import type { Account, Step } from "#core/config/model.ts";
import type { ItemSettled, RunCounts, TerminalRunState } from "#core/run/model.ts";
import type { RunStore } from "#core/run/store.ts";
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
  /** For help and `--map`; the command still parses its own argv. */
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

/** One command-line option, as help, `--map` and the parser all read it. */
export interface OptionSpec {
  readonly flag: `--${string}`;
  readonly short?: `-${string}`;
  /** Present only on an option that takes a value; help prints it after the flag. */
  readonly value?: string;
  readonly multiple?: true;
  readonly describe: string;
}

export interface Example {
  readonly command: string;
  readonly what: string;
}

/**
 * A step kind an adapter implements. Kinds rather than job types: an adapter's
 * step sits beside aireg's own, and the graph is the same either way.
 */
export interface StepContribution {
  kind: string;
  /** CLI flag that selects this kind, e.g. `probe` for `--probe`. */
  flag?: string;
  /** Extra `job add` options this kind accepts. aireg never names them. */
  options?: Readonly<Record<string, FlagSpec>>;
  /** Map those options onto the fields a step of this kind carries. */
  params?(flags: Readonly<Record<string, unknown>>): Record<string, unknown>;
  run(input: StepRunInput): Promise<StepRunResult>;
  describe?(step: Step, registry: string): string;
  /** Keep a job with this step on its interval when nothing changes, instead of backing off. */
  steady?: boolean;
}

/**
 * What an adapter adds beyond the public contract, merged by the host at load so
 * a new command is never a branch in the client. Kept out of the published types.
 */
export interface AdapterExtension {
  commands?: readonly CommandContribution[];
  steps?: readonly StepContribution[];
  /** Tabs on the console. The host merges them with its own. */
  // biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
  panels?: readonly PanelContribution<any>[];
  /** What the console says about the registry this adapter serves. */
  upstream?: UpstreamContribution;
}

/** The hook an adapter module carries beside the contract, under `extend`. */
export function extensionOf(adapter: SourceAdapter): AdapterExtension | undefined {
  const extend: unknown = (adapter as { extend?: unknown }).extend;
  return typeof extend === "object" && extend !== null ? (extend as AdapterExtension) : undefined;
}
