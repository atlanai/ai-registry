import { openAccount } from "#accounts/service.ts";
import type { Account } from "#core/config/model.ts";
import { bindAdapter } from "#core/hook/bind.ts";
import type { ExtensionHost } from "#core/host/extend.ts";
import type { RunStore } from "#core/run/store.ts";
import { ensureHome } from "#core/store/paths.ts";
import { runDatabasePath, SqliteRunStore } from "#daemon/runs/store.ts";

export function extensionHost(version: string): ExtensionHost {
  return {
    version,
    connectAccount: async (account: Account, alias: string, signal: AbortSignal) => {
      const opened = await openAccount(account, alias, {}, signal);
      return { adapter: bindAdapter(opened.adapter, alias), context: opened.context };
    },
    openRunStore: () => {
      ensureHome();
      return SqliteRunStore.open(runDatabasePath()) as Promise<RunStore>;
    },
  };
}
