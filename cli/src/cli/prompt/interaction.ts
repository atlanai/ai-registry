import type { Printer } from "#core/term/printer.ts";
import { prepare } from "./ask.ts";
import { blocker, explain } from "./caller.ts";
import type { PromptIo } from "./model.ts";

/** Shared prompt state for commands that gather missing choices. */
export interface Interaction {
  io: PromptIo;
  printer: Printer;
  /** Undefined when prompting is allowed. */
  blocked: ReturnType<typeof blocker>;
}

export function interaction(printer: Printer, io: PromptIo, yes: boolean): Interaction {
  return {
    io,
    printer,
    blocked: blocker({
      json: printer.format === "json",
      yes,
      isTTY: io.input.isTTY === true,
    }),
  };
}

export function interactive(step: Interaction): boolean {
  return step.blocked === undefined;
}

/** Loads the prompts' renderer behind the slow work that comes before a step's first question. */
export function preparing(step: Interaction): void {
  if (interactive(step)) void prepare();
}

export function silence(step: Interaction): string | undefined {
  return step.blocked === undefined ? undefined : explain(step.blocked);
}

export function cancel(step: Interaction): void {
  step.io.output.write("\n");
  step.printer.info("Canceled. Nothing was changed.");
}
