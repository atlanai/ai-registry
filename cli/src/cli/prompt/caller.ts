import { isCI, present } from "#core/env.ts";
import { CALLER_SIGNALS } from "#core/target/detect.ts";

/**
 * Agents that run aireg without being a target it installs into. One that
 * becomes a target takes its variables into its own definition.
 */
const OTHER_SIGNALS: readonly { agent: string; env: readonly string[] }[] = [
  { agent: "antigravity", env: ["ANTIGRAVITY_AGENT"] },
  { agent: "augment", env: ["AUGMENT_AGENT"] },
  { agent: "replit", env: ["REPL_ID"] },
];

export const SIGNALS = [...CALLER_SIGNALS, ...OTHER_SIGNALS];

/** The agent driving this process, or undefined when a person is. */
export function callingAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Prefer the cross-vendor declaration over inferred vendor signals.
  const declared = env.AI_AGENT?.trim();
  if (declared !== undefined && declared !== "") return declared;
  return SIGNALS.find((signal) => signal.env.some((name) => present(name, env)))?.agent;
}

/** Why a prompt was skipped. Every value maps to something the user can see. */
export type Blocker =
  | { kind: "json" }
  | { kind: "yes" }
  | { kind: "tty" }
  | { kind: "ci" }
  | { kind: "agent"; agent: string };

export interface InteractiveInput {
  json: boolean;
  yes: boolean;
  isTTY: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Explicit output and confirmation flags take precedence over environment signals. */
export function blocker(input: InteractiveInput): Blocker | undefined {
  const env = input.env ?? process.env;
  if (input.json) return { kind: "json" };
  if (input.yes) return { kind: "yes" };
  if (!input.isTTY) return { kind: "tty" };
  const agent = callingAgent(env);
  if (agent !== undefined) return { kind: "agent", agent };
  if (isCI(env)) return { kind: "ci" };
  return undefined;
}

export function explain(reason: Blocker): string {
  switch (reason.kind) {
    case "json":
      return "--json was passed";
    case "yes":
      return "--yes was passed";
    case "tty":
      return "input is not a terminal";
    case "ci":
      return "CI is set";
    case "agent":
      return `it is running inside ${reason.agent}`;
  }
}
