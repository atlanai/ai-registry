import { isAbsolute, resolve } from "node:path";
import { quoted } from "#adapter/text.ts";
import { underHome } from "#cli/render/home.ts";
import { findJob, type Job, jobRoot, type RegistryConfig } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { roots, scopeFor, scopeName, userScopeDir } from "#core/store/paths.ts";

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

/** A folder as a person typed it from `cwd`, kept as typed when it is absolute or under `~`. */
export function typedFolder(folder: string, cwd: string): string {
  return folder.startsWith("~") || isAbsolute(folder) ? folder : resolve(cwd, folder);
}

/** A folder as the job stores it or a person types it, comparable either way, even once deleted. */
export function folderKey(folder: string): string {
  return canonical(resolve(expandUserPath(folder)));
}

/** The scope a job reconciles, by its manifest: the job's own folder, else your user scope. */
export function jobScope(job: Job): string {
  const at = jobRoot(job) ?? userScopeDir();
  return canonical(roots(scopeFor(at), at).manifest);
}

/** The scope at `root` as a person reads it from `cwd`: this project, or the project at a path. */
export function scopeLabel(root: string, cwd: string): string {
  const scope = scopeFor(root);
  return scope === "project" && folderKey(cwd) !== folderKey(root)
    ? `the project at ${underHome(root)}`
    : scopeName(scope);
}
