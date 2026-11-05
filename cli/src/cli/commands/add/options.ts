import type { parse } from "#cli/options/parse.ts";
import type { SourceFlags } from "#engine/address/probe.ts";

export type Parsed = ReturnType<typeof parse<AddFlags>>;

export type AddFlags = SourceFlags & {
  as?: string;
  registry?: string;
  "no-auto-update"?: boolean;
  trust?: string[];
  from?: string | undefined;
};
