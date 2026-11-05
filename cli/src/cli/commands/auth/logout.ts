import { plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { findAccount, needsRegistry, noAccount } from "./shared.ts";

export const LOGOUT_OR_REMOVE =
  "Use logout to sign out and keep the account for its jobs, or remove to delete it.";

/** Clears the credential and keeps the row, so every job keeps its reference. */
export async function logout(context: CommandContext, wanted: string | undefined): Promise<void> {
  if (wanted === undefined) throw needsRegistry("logout");
  const account = findAccount((await readConfig()).accounts, wanted);
  if (account === undefined) throw noAccount(wanted);
  await withDaemon(async (client) => {
    await client.request("account.logout", { accountId: account.id });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { accountId: account.id } })
      : context.printer.success(
          `Signed out of ${account.registry}, keeping the account for its jobs.`,
        );
  });
}

/** Explicit and separate from signing out: this is the one that breaks jobs. */
export async function remove(context: CommandContext, wanted: string | undefined): Promise<void> {
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
  await withDaemon(async (client) => {
    await client.request("account.remove", { accountId: account.id });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { accountId: account.id } })
      : context.printer.success(`Removed the account for ${account.registry}.`);
  });
}
