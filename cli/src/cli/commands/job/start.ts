import { list as listOf, quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { needsJob, noJob } from "#cli/commands/job/find.ts";
import { findJob } from "#core/config/jobs.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRunMode, RUN_MODES } from "#core/run/model.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";

/**
 * One execution of a job, started by a person rather than by the schedule. A job
 * whose schedule is disabled exists for exactly this.
 */
export async function start(
  context: CommandContext,
  wanted: string | undefined,
  requestedMode: string | undefined,
): Promise<void> {
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
  const mode = requestedMode ?? "sync";
  if (!isRunMode(mode)) {
    throw new AiregError(`--mode takes ${listOf(RUN_MODES, "or")}, not ${quoted(mode)}.`, {
      code: ErrorCode.Usage,
      hint: "Leave out `--mode` for a sync.",
    });
  }

  await withDaemon(async (client) => {
    const { run } = await client.request("run.start", {
      jobId: job.id,
      mode,
    });
    if (context.printer.format === "json") {
      context.printer.json({ ok: true, data: { run } });
      return;
    }
    context.printer.success(`Started job ${job.name ?? job.id} as run ${run.id}.`);
    context.printer.info(
      context.printer.style.dim(
        `Follow it with \`aireg job runs ${run.id} --follow\` or \`aireg console\`.`,
      ),
    );
  });
}
