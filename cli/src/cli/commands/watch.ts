import { list as listOf } from "#adapter/text.ts";
import { add as addJob } from "#cli/commands/job/add.ts";
import { folderKey, jobNamed, jobScope, scopeLabel, typedFolder } from "#cli/commands/job/find.ts";
import { WATCH_COMMAND } from "#cli/commands/watch/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { underHome } from "#cli/render/home.ts";
import { jobRoot, unwatchCommand, watchedFolders } from "#core/config/jobs.ts";
import type { Job, Step } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/realpath.ts";
import { type Roots, type Scope, scopeFor, scopeName, userScopeDir } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import type { CommonOptions } from "#engine/options.ts";
import { scopeRoots } from "#engine/scope/locate.ts";
import { FOREGROUND_POLICY } from "#engine/sync/work.ts";
import { type CommandContext, runAction } from "./command.ts";

interface Own extends Record<string, unknown> {
  to?: string;
}

interface Watch {
  folder: string;
  to: string;
  jobId: string;
  scope: Scope;
  /** The project's folder, or your user scope's. */
  root: string;
}

export async function run(context: CommandContext): Promise<void> {
  const spec = WATCH_COMMAND;
  const { positionals, own, common } = parse<Own>(context.argv, spec);
  const [action = "list", ...folders] = positionals;
  return runAction(spec, action, {
    add: () => add(context, folders, own, common),
    remove: () => remove(context, folders, common),
    list: () => list(context),
  });
}

/** The folder a job keeps in sync: its own, else your user scope's. */
const rootOf = (job: Job) => jobRoot(job) ?? userScopeDir();

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
      { header: "scope", value: (item: Watch) => scopeLabel(item.root, context.cwd) },
    ],
    found,
  );
}

function watches(jobs: readonly Job[]): Watch[] {
  return jobs.flatMap((job) => {
    const root = rootOf(job);
    const scope = scopeFor(root);
    return job.steps.flatMap(({ kind, to, select }) =>
      kind !== "origins" || to === undefined
        ? []
        : select.map(({ from }) => ({ folder: folderKey(from), to, jobId: job.id, scope, root })),
    );
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

function needsFolder(action: string): AiregError {
  return new AiregError(`\`aireg watch ${action}\` needs a folder.`, {
    code: ErrorCode.Usage,
    hint:
      action === "add"
        ? "Name it: `aireg watch add <folder> --to <registry>/<namespace>`."
        : "Name it: `aireg watch remove <folder>`. Run `aireg watch list` to see them.",
  });
}

async function remove(
  context: CommandContext,
  folders: string[],
  common: CommonOptions,
): Promise<void> {
  if (folders.length === 0) throw needsFolder("remove");
  const scope = scopeRoots(common, context.cwd, "user");
  const found = byJob((await readConfig()).jobs, folders, scope, context.cwd);
  for (const [job, dropped] of found) await unwatch(context, job, dropped);
}

/** Each folder named, as a key, under the job in this scope that watches it. */
function byJob(all: readonly Job[], folders: readonly string[], scope: Roots, cwd: string) {
  const here = canonical(scope.manifest);
  const found = new Map<Job, Set<string>>();
  for (const folder of folders) {
    const wanted = folderKey(typedFolder(folder, cwd));
    const watches = (job: Job) => watchedFolders(job).some((at) => folderKey(at) === wanted);
    const job = all.find((item) => jobScope(item) === here && watches(item));
    if (job === undefined) {
      const other = all.find(watches);
      throw new AiregError(
        `${underHome(wanted)} is not published from ${scopeName(scope.scope)}.`,
        {
          code: ErrorCode.Usage,
          hint:
            other === undefined
              ? "Run `aireg watch list` to see the folders that are."
              : elsewhere(other, wanted, cwd),
        },
      );
    }
    found.set(job, (found.get(job) ?? new Set()).add(wanted));
  }
  return found;
}

/** How to stop a folder another scope publishes: with -g, or in that project. */
function elsewhere(job: Job, folder: string, cwd: string): string {
  const root = rootOf(job);
  const scope = scopeFor(root);
  const command = unwatchCommand([underHome(folder)], scope);
  return scope === "user"
    ? `It is published from your user scope: run \`${command}\`.`
    : `It is published from ${scopeLabel(root, cwd)}: run \`${command}\` there.`;
}

/** Stops publishing the folders and keeps the job, which goes on keeping its scope in sync. */
async function unwatch(context: CommandContext, job: Job, dropped: ReadonlySet<string>) {
  await withDaemon(async (client) => {
    const { before, after } = await withFreshConfig(client, async (config) => {
      const before = jobNamed(config, job.id);
      const after = withoutFolders(before, dropped);
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { upsert: [after] },
      });
      return { before, after };
    });
    const watching = watchedFolders(after);
    if (context.printer.format === "json") {
      context.printer.json({ ok: true, data: { jobId: after.id, watching } });
      return;
    }
    const stopped = watchedFolders(before).filter((folder) => !watching.includes(folder));
    const name = after.name ?? after.id;
    context.printer.success(
      `Stopped watching ${listOf(stopped.map(underHome))}. ` +
        (watching.length === 0
          ? `Job ${name} still keeps ${scopeLabel(rootOf(after), context.cwd)} up to date.`
          : `Job ${name} still watches ${listOf(watching.map(underHome))}.`),
    );
  });
}

/**
 * The job without those folders. With none left it goes back to the job `aireg add`
 * makes: no folder step, and edits made here reported rather than published.
 */
function withoutFolders(job: Job, dropped: ReadonlySet<string>): Job {
  const steps = job.steps.flatMap((step): Step[] => {
    if (step.kind !== "origins") return [step];
    const select = step.select.filter((selector) => !dropped.has(folderKey(selector.from)));
    return select.length === 0 ? [] : [{ ...step, select }];
  });
  if (steps.some((step) => step.kind === "origins")) return { ...job, steps };
  const origins = job.steps.find((step) => step.kind === "origins")?.name;
  // A watch turned publishing on for its folders; without them the publish step reports again.
  return {
    ...job,
    steps: steps.map((step) => ({
      ...step,
      needs: step.needs.filter((name) => name !== origins),
      policy:
        step.kind === "publish" && step.policy === "on" ? FOREGROUND_POLICY.publish : step.policy,
    })),
  };
}
