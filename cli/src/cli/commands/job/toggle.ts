import type { CommandContext } from "#cli/commands/command.ts";
import { existing, jobNamed, needsJob } from "#cli/commands/job/find.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

export async function setEnabled(
  context: CommandContext,
  wanted: string | undefined,
  enabled: boolean,
): Promise<void> {
  const action = enabled ? "enable" : "disable";
  if (wanted === undefined) throw needsJob(action);
  await existing(wanted);
  await withDaemon(async (client) => {
    const job = await withFreshConfig(client, async (config) => {
      const found = jobNamed(config, wanted);
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { upsert: [{ ...found, schedule: { ...found.schedule, enabled } }] },
      });
      return found;
    });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { jobId: job.id, enabled } })
      : context.printer.success(`${enabled ? "Enabled" : "Disabled"} job ${job.name ?? job.id}.`);
  });
}

export async function setPaused(
  context: CommandContext,
  paused: boolean,
  argument: string | undefined,
): Promise<void> {
  if (argument !== undefined) {
    const action = paused ? "pause" : "resume";
    throw new AiregError(
      `\`aireg job ${action}\` takes no job name; it ${paused ? "pauses" : "resumes"} every job.`,
      {
        code: ErrorCode.Usage,
        hint: `To ${paused ? "disable" : "enable"} one job, run \`aireg job ${paused ? "disable" : "enable"} ${argument}\`.`,
      },
    );
  }
  await withDaemon(async (client) => {
    const updated = await withFreshConfig(client, (config) =>
      client.request("settings.patch", { expectedRevision: config.revision, paused }),
    );
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { paused, revision: updated.config.revision } })
      : context.printer.success(paused ? "Paused every job." : "Resumed every job.");
  });
}
