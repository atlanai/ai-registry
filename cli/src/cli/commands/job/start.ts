import { list as listOf } from "#adapter/text.ts";
import { action } from "#cli/commands/define.ts";
import { needsJob, noJob } from "#cli/commands/job/find.ts";
import type { JobOptions } from "#cli/commands/job/options.ts";
import type { JobRun } from "#cli/commands/job/result.ts";
import { findJob } from "#core/config/jobs.ts";
import { readConfig } from "#core/config/repository.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";

/** Started by a person rather than the schedule, which is all a disabled job does. */
export const start = action({
  async run({ argument: wanted, own }: JobOptions): Promise<Started> {
    if (wanted === undefined) throw needsJob("start");
    const config = await readConfig();
    const job = findJob(config, wanted);
    if (job === undefined) {
      const known = config.jobs.map((entry) => entry.name ?? entry.id);
      throw noJob(
        wanted,
        known.length === 0 ? "Run `aireg job add` to add one." : `The jobs are ${listOf(known)}.`,
      );
    }
    const mode = own.mode ?? "sync";
    const { run } = await withDaemon((client) =>
      client.request("run.start", {
        jobId: job.id,
        mode,
      }),
    );
    return { run, job: job.name ?? job.id };
  },
  data: ({ run }): JobRun => ({ run }),
  text(result, printer) {
    printer.success(`Started job ${result.job} as run ${result.run.id}.`);
    printer.info(
      printer.style.dim(
        `Follow it with \`aireg job runs ${result.run.id} --follow\` or \`aireg console\`.`,
      ),
    );
  },
});

interface Started extends JobRun {
  job: string;
}
