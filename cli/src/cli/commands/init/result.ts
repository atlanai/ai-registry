import type { Step } from "#cli/onboarding/flow.ts";

interface Written {
  manifest: string;
  scope: "project";
  targets: string[];
  imported: number;
}

export interface InitNext extends Written {
  next: string[];
}

/** `aireg init --registry`, which lists each step it took instead of `next`. */
export interface InitSteps extends Written {
  steps: Step[];
}

export type InitResult = InitNext | InitSteps;
