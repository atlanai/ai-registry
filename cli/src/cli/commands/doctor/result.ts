import type { Capabilities } from "#adapter/contract.ts";

export interface DoctorResult {
  /** How many checks are not ok. */
  problems: number;
  checks: Check[];
  adapters: LoadedAdapter[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What fixes or improves it; commands joined with ` && ` print one per line. */
  fix?: string;
  /** Worth knowing, with nothing to do. */
  info?: boolean;
}

interface LoadedAdapter {
  id: string;
  displayName: string;
  capabilities: Capabilities;
}
