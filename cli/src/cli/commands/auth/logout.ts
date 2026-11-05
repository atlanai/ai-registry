import { plural } from "#adapter/text.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { findAccount, needsRegistry, noAccount } from "./shared.ts";

export const LOGOUT_OR_REMOVE =
  "Use logout to sign out and keep the account for its jobs, or remove to delete it.";

export interface ChangedAccount {
  accountId: string;
  registry: string;
}

/** Keeps the row, so every job keeps its reference. */
export async function logout(wanted: string | undefined): Promise<ChangedAccount> {
  if (wanted === undefined) throw needsRegistry("logout");
  const account = findAccount((await readConfig()).accounts, wanted);
  if (account === undefined) throw noAccount(wanted);
  await withDaemon((client) => client.request("account.logout", { accountId: account.id }));
  return { accountId: account.id, registry: account.registry };
}

/** Separate from logout: this is the one that breaks jobs. */
export async function remove(wanted: string | undefined): Promise<ChangedAccount> {
  if (wanted === undefined) throw needsRegistry("remove");
  const config = await readConfig();
  const account = findAccount(config.accounts, wanted);
  if (account === undefined) throw noAccount(wanted);
  const jobs = config.jobs.filter(({ account: id }) => id === account.id);
  if (jobs.length > 0) {
    throw new AiregError(
      `The account for ${account.registry} is used by ${plural(jobs.length, "job")}.`,
      {
        code: ErrorCode.Conflict,
        hint: `Remove those jobs first with \`aireg job remove <job>\`, or run \`aireg auth logout ${account.registry}\` to keep them.`,
      },
    );
  }
  await withDaemon((client) => client.request("account.remove", { accountId: account.id }));
  return { accountId: account.id, registry: account.registry };
}
