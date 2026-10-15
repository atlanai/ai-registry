import { quoted } from "#adapter/text.ts";
import { findJob, type Job, type RegistryConfig } from "#core/config/model.ts";
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

/** The job a person named, by id or name; an error when no job has it. */
export function jobNamed(config: RegistryConfig, wanted: string): Job {
  const job = findJob(config, wanted);
  if (job === undefined) throw noJob(wanted);
  return job;
}

/** Looked up before the daemon starts: naming a job that does not exist does not need it. */
export async function existing(wanted: string): Promise<void> {
  jobNamed(await readConfig(), wanted);
}
