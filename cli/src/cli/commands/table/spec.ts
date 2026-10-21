import type { ExitCode } from "#core/errors.ts";
import type { Example, HostCommandContext, OptionSpec } from "#core/host/extend.ts";

export type CommandContext = HostCommandContext & {
  /** Set by a command that reports a state rather than a failure. */
  exit?: ExitCode;
};

type CommandRun = (context: CommandContext) => Promise<void>;

/**
 * The order here is the order `--help` prints, and it is the order a new user
 * meets the tool in: set something up, install into it, check it, share it.
 */
export const GROUPS = ["Set up", "Install", "Check", "Share", "Automate", "Maintain"] as const;

export type Group = (typeof GROUPS)[number];

/** One verb of a command that has several: `aireg registry add`. */
export interface ActionSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** Absent only on an adapter's action, which declares just its name. */
  readonly summary?: string;
  readonly usage?: readonly string[];
  readonly examples?: readonly Example[];
  /** Everything the action takes; nothing is inherited from the command. */
  readonly options?: readonly OptionSpec[];
  /** The most words it takes after its name; absent takes any number. */
  readonly maxArguments?: number;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  summary: string;
  group: Group;
  usage: readonly string[];
  examples?: readonly Example[];
  /** A page under docs/reference/ without `.md`, or a URL for an adapter's command. */
  docs?: string;
  /** What the command takes when no action is named. */
  options?: readonly OptionSpec[];
  /** The most words it takes; absent takes any number. */
  readonly maxArguments?: number;
  actions?: readonly ActionSpec[];
  /** Loaded only when the command runs. */
  load: () => Promise<{ run: CommandRun }>;
}
