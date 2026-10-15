import { quoted } from "#adapter/text.ts";
import { findJob } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

export function noJob(wanted: string, hint = "Run `aireg job list` to see the jobs."): AiregError {
  return new AiregError(`No job named ${quoted(wanted)}.`, { code: ErrorCode.NotFound, hint });
}

export function needsJob(action: string): AiregError {
  return new AiregError(`\`aireg job ${action}\` needs a job name.`, {
    code: ErrorCode.Usage,
    hint: `Name the job: \`aireg job ${action} <job>\`.`,
  });
}

/** Looked up before the daemon starts: naming a job that does not exist does not need it. */
export async function existing(wanted: string): Promise<void> {
  if (findJob(await readConfig(), wanted) === undefined) throw noJob(wanted);
}
