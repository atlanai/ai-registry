import type { SourceFlags } from "#engine/address/probe.ts";
import type { CommonOptions } from "#engine/options.ts";

export interface Flags extends SourceFlags {
  as?: string;
  name?: string;
  description?: string;
  namespace?: string[];
  base?: string;
}

export interface Options {
  argument: string | undefined;
  flags: Flags;
  common: CommonOptions;
}
