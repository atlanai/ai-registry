import { quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { needsInput } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { StepContribution } from "#core/host/extend.ts";
import { type RpcClient, withFreshConfig } from "#daemon/rpc/client.ts";

/** `job add --<flag>`: an adapter-contributed type owns no project tree. */
export async function addContributedJob(
  context: CommandContext,
  client: RpcClient,
  contribution: StepContribution,
  flags: Record<string, unknown>,
  intervalSeconds: number,
): Promise<void> {
  if (typeof flags.account !== "string") {
    const flag = contribution.flag ?? contribution.kind;
    throw needsInput(
      `job add --${flag}`,
      "an account",
      `Name the account: \`aireg job add --${flag} --account <account>\`.`,
    );
  }
  const extra = contribution.params?.(flags) ?? {};
  const { config: updated, job } = await withFreshConfig(client, (config) => {
    const account = config.accounts.find(
      ({ id, registry }) => id === flags.account || registry === flags.account,
    );
    if (account === undefined) {
      throw new AiregError(`No account named ${quoted(flags.account as string)}.`, {
        code: ErrorCode.NotFound,
        hint: "Run `aireg auth list` to see your accounts.",
      });
    }
    return client.request("job.create", {
      type: contribution.kind,
      expectedRevision: config.revision,
      account: account.id,
      intervalSeconds,
      ...(typeof flags.name === "string" ? { name: flags.name } : {}),
      ...extra,
    });
  });
  context.printer.format === "json"
    ? context.printer.json({ ok: true, data: { job, revision: updated.revision } })
    : context.printer.success(`Added ${contribution.kind} job ${job.id}.`);
}
