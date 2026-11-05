import { messageOf } from "#adapter/errors.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import { scopeFor, userScopeDir } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { autostartState } from "#daemon/autostart/index.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

export type Kept =
  | {
      jobId: string;
      /** Every artifact named was pinned, so background updates leave it where it is. */
      pinned: boolean;
      /** The daemon does not start at login, so the job runs only while it is started. */
      autostartOff: boolean;
    }
  | { alias: string; failed: string };

/** Created once and never rewritten, so a policy someone set stays set. */
export async function keepCurrent(
  alias: string,
  config: Readonly<Record<string, string>>,
  pinned: boolean,
): Promise<Kept> {
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
    return { alias, failed: messageOf(error) };
  }
  const autostart = await autostartState().catch(() => undefined);
  return { jobId, pinned, autostartOff: autostart !== undefined && !autostart.registered };
}

export function printKept(printer: Printer, kept: Kept): void {
  if ("failed" in kept) {
    printer.warning(`Installed, but could not turn on background updates: ${kept.failed}`);
    printer.hint(`Run \`aireg job add -g --registry ${kept.alias}\` to try again.`);
    return;
  }
  printer.note(
    "kept",
    kept.pinned
      ? "at the version pinned; background updates leave it there"
      : `up to date every ${DEFAULT_INTERVAL_WORDS}, in the background`,
  );
  if (kept.autostartOff) printer.note("next", "aireg daemon autostart on");
}
