import { updateAdapters } from "#core/adapter/installed/update.ts";
import { VERSION } from "#core/version.ts";
import { skipMinimumUpdate } from "#self/minimum-update.ts";
import { type DaemonReplaceHooks, replaceWith } from "./cli-update.ts";

export interface DaemonAdapterUpdateHooks extends DaemonReplaceHooks {
  skip?: (env: NodeJS.ProcessEnv) => boolean;
  update?: (env: NodeJS.ProcessEnv) => Promise<readonly string[]>;
}

/** A daemon only loads adapters at start, so an update is followed by a restart. */
export async function applyDaemonAdapterUpdate(
  hooks: DaemonAdapterUpdateHooks,
): Promise<"skip" | "replace"> {
  const env = hooks.env ?? process.env;
  if ((hooks.skip ?? skipMinimumUpdate)(env) || hooks.busy()) return "skip";
  const updated = await (hooks.update ?? updateAdapters)(env);
  if (updated.length === 0) return "skip";
  return replaceWith(hooks, hooks.current ?? VERSION, env);
}
