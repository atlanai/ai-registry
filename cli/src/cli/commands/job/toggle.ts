import { action } from "#cli/commands/define.ts";
import { existing, jobNamed, needsJob } from "#cli/commands/job/find.ts";
import type { JobOptions } from "#cli/commands/job/options.ts";
import type { JobsPaused, JobToggled } from "#cli/commands/job/result.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

export const enable = toggle(true);

export const disable = toggle(false);

export const pause = pausing(true);

export const resume = pausing(false);

interface Toggled extends JobToggled {
  job: string;
}

function toggle(enabled: boolean) {
  return action({
    async run({ argument: wanted }: JobOptions): Promise<Toggled> {
      if (wanted === undefined) throw needsJob(enabled ? "enable" : "disable");
      await existing(wanted);
      const job = await withDaemon((client) =>
        withFreshConfig(client, async (config) => {
          const found = jobNamed(config, wanted);
          await client.request("settings.patch", {
            expectedRevision: config.revision,
            jobs: { upsert: [{ ...found, schedule: { ...found.schedule, enabled } }] },
          });
          return found;
        }),
      );
      return { jobId: job.id, enabled, job: job.name ?? job.id };
    },
    data: (result): JobToggled => ({ jobId: result.jobId, enabled: result.enabled }),
    text: (result, printer) =>
      printer.success(`${enabled ? "Enabled" : "Disabled"} job ${result.job}.`),
  });
}

function pausing(paused: boolean) {
  return action({
    async run({ argument }: JobOptions): Promise<JobsPaused> {
      if (argument !== undefined) {
        const verb = paused ? "pause" : "resume";
        throw new AiregError(
          `\`aireg job ${verb}\` takes no job name; it ${paused ? "pauses" : "resumes"} every job.`,
          {
            code: ErrorCode.Usage,
            hint: `To ${paused ? "disable" : "enable"} one job, run \`aireg job ${paused ? "disable" : "enable"} ${argument}\`.`,
          },
        );
      }
      const updated = await withDaemon((client) =>
        withFreshConfig(client, (config) =>
          client.request("settings.patch", { expectedRevision: config.revision, paused }),
        ),
      );
      return { paused, revision: updated.config.revision };
    },
    text: (result, printer) =>
      printer.success(result.paused ? "Paused every job." : "Resumed every job."),
  });
}
