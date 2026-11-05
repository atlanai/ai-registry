import * as accounts from "#accounts/service.ts";
import type { Identity } from "#adapter/index.ts";
import type { Account } from "#core/config/model.ts";
import type { RpcContext } from "#daemon/rpc/methods.ts";
import * as inputs from "./params.ts";
import { committed } from "./settings-write.ts";

export async function loginAccount(
  raw: unknown,
  context: RpcContext,
): Promise<{ account: Account; created: boolean; identity?: Identity }> {
  const params = inputs.object(raw);
  const { account, created, identity } = await committed(() =>
    accounts.signIn(
      {
        registry: inputs.text(params, "registry"),
        ...(params.address === undefined ? {} : { address: inputs.text(params, "address") }),
        ...(params.adapter === undefined ? {} : { adapter: inputs.text(params, "adapter") }),
        ...(params.config === undefined ? {} : { config: inputs.sourceConfig(params, "config") }),
        ...(params.defaultNamespace === undefined
          ? {}
          : { defaultNamespace: inputs.text(params, "defaultNamespace") }),
      },
      {
        ...(params.token === undefined ? {} : { token: inputs.text(params, "token") }),
        ...(params.oauth === undefined ? {} : { oauth: inputs.oauthTokens(params, "oauth") }),
      },
      context.signal,
    ),
  );
  return { account, created, ...(identity === undefined ? {} : { identity }) };
}

export async function logoutAccount(
  raw: unknown,
  context: RpcContext,
): Promise<{ accountId: string }> {
  const accountId = inputs.text(inputs.object(raw), "accountId");
  await committed(() => accounts.signOut(accountId, context.signal));
  return { accountId };
}

/** Deleting the row is the destructive one, so it is its own method. */
export async function removeAccount(
  raw: unknown,
  context: RpcContext,
): Promise<{ accountId: string }> {
  const accountId = inputs.text(inputs.object(raw), "accountId");
  await committed(() => accounts.removeAccount(accountId, context.signal));
  return { accountId };
}
