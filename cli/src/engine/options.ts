import type { Scope } from "#core/store/paths.ts";

export interface CommonOptions {
  scope: Scope | undefined;
  targets: string[] | undefined;
  select: string[] | undefined;
  yes: boolean;
  all: boolean;
  dryRun: boolean;
  frozen: boolean;
  force: boolean;
  copy: boolean;
}
