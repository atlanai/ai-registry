import type { AccountService } from "#accounts/service.ts";
import type { Credential } from "#adapter/index.ts";
import { quoted } from "#adapter/text.ts";
import { needsInput } from "#cli/options/parse.ts";
import type { Account } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

/** A job stores the id, and a person types the alias. */
export function findAccount(accounts: readonly Account[], wanted: string): Account | undefined {
  return accounts.find(({ id, registry }) => id === wanted || registry === wanted);
}

/**
 * A job keeps an account for a folder or git registry too, which has nothing to sign in
 * to. One whose registry cannot be read now is taken to need a sign-in.
 */
export async function needsSignIn(service: AccountService, account: Account): Promise<boolean> {
  try {
    return (await service.resolve(account)).adapter.auth?.login !== undefined;
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

export function noAccount(wanted: string): AiregError {
  return new AiregError(`No account named ${quoted(wanted)}.`, {
    code: ErrorCode.NotFound,
    hint: "Run `aireg auth list` to see the accounts.",
  });
}
