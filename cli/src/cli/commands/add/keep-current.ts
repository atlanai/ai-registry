import { messageOf } from "#adapter/errors.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import { scopeFor, userScopeDir } from "#core/store/paths.ts";
import { autostartState } from "#daemon/autostart/index.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

/**
 * One background job per registry keeps the user scope current. It is created
 * once and never rewritten, so a policy someone set stays set. Returns its id.
 */
export async function keepCurrent(
  context: CommandContext,
  alias: string,
  config: Readonly<Record<string, string>>,
  pinned: boolean,
): Promise<string | undefined> {
  let jobId: string;
  try {
    jobId = await withDaemon((client) =>
      withFreshConfig(client, async (state) => {
        const account = state.accounts.find((item) => item.registry === alias);
        const watched = state.jobs.find(
          (job) =>
            job.account === account?.id &&
            job.steps.some((step) => step.root !== undefined && scopeFor(step.root) === "user"),
        );
        if (watched !== undefined) return watched.id;
        const { job } = await client.request("job.create", {
          expectedRevision: state.revision,
          root: userScopeDir(),
          scope: "user",
          registry: alias,
          config,
          declaredOnly: true,
        });
        return job.id;
      }),
    );
  } catch (error) {
    context.printer.warning(
      `Installed, but could not turn on background updates: ${messageOf(error)}`,
    );
    context.printer.hint(`Run \`aireg job add -g --registry ${alias}\` to try again.`);
    return undefined;
  }
  context.printer.note(
    "kept",
    pinned
      ? "at the version pinned; background updates leave it there"
      : `up to date every ${DEFAULT_INTERVAL_WORDS}, in the background`,
  );
  const autostart = await autostartState().catch(() => undefined);
  if (autostart !== undefined && !autostart.registered) {
    context.printer.note("next", "aireg daemon autostart on");
  }
  return jobId;
}
