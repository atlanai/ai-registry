import { canSignIn } from "#adapter/contract.ts";
import { sanitizeText, withoutCredentials } from "#adapter/text.ts";
import { adapterFor, declaredLayout } from "#core/adapter/load.ts";
import type { Account, RegistryConfig } from "#core/config/model.ts";
import type { AccountRow } from "#core/console/model.ts";
import { signedInAccounts } from "#core/credentials/store.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { credentialsPath } from "#core/store/paths.ts";

export async function readAccounts(
  config: RegistryConfig,
  manifest: Manifest,
  counts: AccountCounts,
): Promise<AccountRow[]> {
  const signedIn = await signedInAccounts();
  return Promise.all(
    config.accounts.map((account) =>
      describe(
        account,
        manifest,
        counts.byAlias[account.registry] ?? { artifacts: 0, namespaces: 0 },
        signedIn.has(account.id),
      ),
    ),
  );
}

/** `auth list` does not say where a token lives, so each row does. */
async function describe(
  account: Account,
  manifest: Manifest,
  counts: { artifacts: number; namespaces: number },
  signedIn: boolean,
): Promise<AccountRow> {
  const declared = manifest.registries[account.registry];
  const { signIn, publishes } = await abilities(manifest, account.registry);
  // A cloned project's manifest chose the address, and Ink prints escapes as they are.
  return {
    id: account.id,
    registry: account.registry,
    address: sanitizeText(withoutCredentials(declared?.location ?? ""), 2048),
    config: declared?.config ?? {},
    credentialsFile: signedIn ? credentialsPath() : undefined,
    signedIn,
    signIn,
    publishes,
    defaultNamespace: account.defaultNamespace,
    artifactCount: counts.artifacts,
    namespaceCount: counts.namespaces,
  };
}

export interface AccountCounts {
  /** Installed artifacts and distinct namespaces, by registry alias. */
  byAlias: Readonly<Record<string, { artifacts: number; namespaces: number }>>;
}

/**
 * One with no sign-in has no account state to show, and one that takes no publishes
 * has nothing to publish to. An adapter that cannot be told apart is shown as able to.
 */
async function abilities(
  manifest: Manifest,
  alias: string,
): Promise<{ signIn: boolean; publishes: boolean }> {
  const declared = manifest.registries[alias];
  if (declared === undefined) return { signIn: true, publishes: true };
  try {
    const adapter = await adapterFor(
      declared.location,
      declared.adapter,
      declaredLayout(declared.config),
    );
    return { signIn: canSignIn(adapter), publishes: adapter.capabilities.publish };
  } catch {
    return { signIn: true, publishes: true };
  }
}
