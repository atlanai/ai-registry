import type { SourceFlags } from "#engine/address/probe.ts";

export interface Flags extends SourceFlags {
  as?: string;
  name?: string;
  description?: string;
  namespace?: string[];
  base?: string;
}
