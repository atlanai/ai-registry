import { resolveAccount } from "#accounts/service.ts";
import type { Credential } from "#adapter/index.ts";
import { needsInput } from "#cli/options/parse.ts";
import type { Account } from "#core/config/model.ts";
import { AiregError } from "#core/errors.ts";

/** A job stores the id, and a person types the alias. */
export function findAccount(accounts: readonly Account[], wanted: string): Account | undefined {
  return accounts.find(({ id, registry }) => id === wanted || registry === wanted);
}

/**
 * A folder or git registry has nothing to sign in to. One whose registry cannot be
 * read now is taken to need a sign-in.
 */
export async function needsSignIn(account: Account): Promise<boolean> {
  try {
    return (await resolveAccount(account)).adapter.auth?.login !== undefined;
  } catch {
    return true;
  }
}

export function tokensOf(credential: Credential): {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
} {
  if (credential.type !== "bearer") throw new AiregError("The sign-in returned no bearer token.");
  const { accessToken, refreshToken, expiresAtMs } = credential;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

export function needsRegistry(action: string): AiregError {
  return needsInput(
    `auth ${action}`,
    "a registry name",
    `Name the registry: \`aireg auth ${action} <registry>\`.`,
  );
}
