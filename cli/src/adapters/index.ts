import { ID as GIT } from "#adapters/git/api.ts";
import { ID as LOCAL } from "#adapters/local/api.ts";
import { ID as WELL_KNOWN } from "#adapters/well-known/api.ts";
import { registerBuiltinAdapter } from "#core/adapter/registry.ts";
import { envName, gitTimeoutMs } from "#core/env.ts";

/** The adapters built into aireg; others install with `aireg adapter install`. */
export function registerBuiltinAdapters(): void {
  // A clone can take minutes, not the half minute other sources get.
  registerBuiltinAdapter(GIT, () => import("#adapters/git/index.ts"), {
    fallback: true,
    limits: () => ({ timeoutMs: gitTimeoutMs(), timeoutSetting: envName("GIT_TIMEOUT_MS") }),
  });
  registerBuiltinAdapter(LOCAL, () => import("#adapters/local/index.ts"));
  registerBuiltinAdapter(WELL_KNOWN, () => import("#adapters/well-known/index.ts"));
}
