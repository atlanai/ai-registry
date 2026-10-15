import { folderKey, jobScope, typedFolder } from "#cli/commands/job/find.ts";
import { add as addJob } from "#cli/commands/job.ts";
import { parse } from "#cli/options.ts";
import { underHome } from "#cli/render/home.ts";
import { type Job, watchedFolders } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { type Roots, type Scope, scopeFor, scopeName } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import type { CommonOptions } from "#engine/options.ts";
import { scopeRoots } from "#engine/pipeline.ts";
import { builtin, type CommandContext, runAction } from "./index.ts";

interface Own extends Record<string, unknown> {
  to?: string;
}

interface Watch {
  folder: string;
  to: string;
  jobId: string;
  scope: string;
}

function needsFolder(action: string): AiregError {
  return new AiregError(`\`aireg watch ${action}\` needs a folder.`, {
    code: ErrorCode.Usage,
    hint:
      action === "add"
        ? "Name it: `aireg watch add <folder> --to <registry>/<namespace>`."
        : "Name it: `aireg watch remove <folder>`. Run `aireg watch list` to see them.",
  });
}

/** A watch is the scope's sync job publishing a folder too, so adding one is `job add --watch`. */
async function add(
  context: CommandContext,
  folders: string[],
  own: Own,
  common: CommonOptions,
): Promise<void> {
  if (folders.length === 0) throw needsFolder("add");
  await addJob(
    context,
    undefined,
    { watch: folders, ...(own.to === undefined ? {} : { to: own.to }) },
    common,
  );
}

/** Each folder named, by the job in this scope that watches it. */
function byJob(
  all: readonly Job[],
  folders: readonly string[],
  scope: Roots,
  cwd: string,
): Map<Job, string[]> {
  const here = canonical(scope.manifest);
  const watches = (job: Job, wanted: string) =>
    watchedFolders(job).some((at) => folderKey(at) === wanted);
  const found = new Map<Job, string[]>();
  for (const folder of folders) {
    const wanted = folderKey(typedFolder(folder, cwd));
    const job = all.find((item) => jobScope(item) === here && watches(item, wanted));
    if (job === undefined) {
      const elsewhere = all.find((item) => watches(item, wanted));
      throw new AiregError(
        `${underHome(wanted)} is not published from ${scopeName(scope.scope)}.`,
        {
          code: ErrorCode.Usage,
          hint:
            elsewhere === undefined
              ? "Run `aireg watch list` to see the folders that are."
              : from(elsewhere, folder),
        },
      );
    }
    found.set(job, [...(found.get(job) ?? []), folder]);
  }
  return found;
}

/** Stops publishing the folders; the job goes on keeping the scope in sync. */
async function remove(
  context: CommandContext,
  folders: string[],
  common: CommonOptions,
): Promise<void> {
  if (folders.length === 0) throw needsFolder("remove");
  const scope = scopeRoots(common, context.cwd, "user");
  const jobs = (await readConfig()).jobs;
  const { unwatch } = await import("#cli/commands/job/remove.ts");
  for (const [job, named] of byJob(jobs, folders, scope, context.cwd)) {
    await unwatch(context, job.id, named);
  }
}

/** How to stop a folder another scope publishes: with -g, or in that project. */
function from(job: Job, folder: string): string {
  const root = job.steps.find((item) => item.root !== undefined)?.root;
  return root === undefined || scopeFor(root) === "user"
    ? `It is published from your user scope: run \`aireg watch remove ${folder} -g\`.`
    : `It is published from the project at ${underHome(root)}: run \`aireg watch remove ${folder}\` there.`;
}

/** Your user scope, or a project, as the job's own folder says. */
function scopeOf(job: Job): Scope {
  const root = job.steps.find((item) => item.root !== undefined)?.root;
  return root === undefined ? "user" : scopeFor(root);
}

function watches(jobs: readonly Job[]): Watch[] {
  return jobs.flatMap((job) => {
    const scope = scopeName(scopeOf(job));
    return job.steps.flatMap(({ kind, to, select }) =>
      kind !== "origins" || to === undefined
        ? []
        : select.map(({ from }) => ({ folder: folderKey(from), to, jobId: job.id, scope })),
    );
  });
}

async function list(context: CommandContext): Promise<void> {
  const found = watches((await readConfig()).jobs);
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { watches: found } });
    return;
  }
  if (found.length === 0) {
    context.printer.info("No folder is published as it changes.");
    context.printer.hint("Run `aireg watch add <folder> --to <registry>/<namespace>` to add one.");
    return;
  }
  table(
    context.printer,
    [
      { header: "folder", value: (item: Watch) => underHome(item.folder) },
      { header: "to", value: (item: Watch) => item.to },
      { header: "job", value: (item: Watch) => item.jobId },
      { header: "scope", value: (item: Watch) => item.scope },
    ],
    found,
  );
}

export async function run(context: CommandContext): Promise<void> {
  const spec = builtin("watch");
  const { positionals, own, common } = parse<Own>(context.argv, spec);
  const [action = "list", ...folders] = positionals;
  return runAction(spec, action, {
    add: () => add(context, folders, own, common),
    remove: () => remove(context, folders, common),
    list: () => list(context),
  });
}
