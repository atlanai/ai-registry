import { list as listOf } from "#adapter/text.ts";
import { type Saved, savedData, savedText, saveJob } from "#cli/commands/job/add.ts";
import { folderKey, jobNamed, jobScope, scopeLabel, typedFolder } from "#cli/commands/job/find.ts";
import type { WatchList, WatchRemoved, WatchRemoveResult } from "#cli/commands/watch/result.ts";
import { WATCH_COMMAND } from "#cli/commands/watch/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { underHome } from "#cli/render/home.ts";
import { jobRoot, unwatchCommand, watchedFolders } from "#core/config/jobs.ts";
import type { Job, Step } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/realpath.ts";
import { type Roots, scopeFor, scopeName, userScopeDir } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import type { CommonOptions } from "#engine/options.ts";
import { scopeRoots } from "#engine/scope/locate.ts";
import { FOREGROUND_POLICY } from "#engine/sync/work.ts";
import type { CommandContext } from "./command.ts";
import { action, defineCommand } from "./define.ts";

interface Own extends Record<string, unknown> {
  to?: string;
}

interface Options {
  folders: string[];
  own: Own;
  common: CommonOptions;
}

type Watch = WatchList["watches"][number];

interface Listed extends WatchList {
  cwd: string;
}

export const { run } = defineCommand<Options>({
  spec: WATCH_COMMAND,
  parse(argv) {
    const { positionals, own, common } = parse<Own>(argv, WATCH_COMMAND);
    const [verb = "list", ...folders] = positionals;
    return { action: verb, options: { folders, own, common } };
  },
  actions: {
    // A watch is the scope's sync job also publishing a folder, so adding one is `job add --watch`.
    add: action({
      run: ({ folders, own, common }, context): Promise<Saved> => {
        if (folders.length === 0) throw needsFolder("add");
        const watch = { watch: folders, ...(own.to === undefined ? {} : { to: own.to }) };
        return saveJob(context, undefined, watch, common);
      },
      data: savedData,
      text: savedText,
    }),
    // Folders may span several jobs; each is saved on its own, so its result prints as it lands.
    remove: action({
      run: async ({ folders, common }, context): Promise<Unwatched> => ({
        jobs: await remove(context, folders, common),
        cwd: context.cwd,
      }),
      // One job prints as it always has; several print as one document.
      data: ({ jobs }): WatchRemoveResult => {
        const removed = jobs.map(({ after }) => ({
          jobId: after.id,
          watching: watchedFolders(after),
        }));
        return removed.length === 1 ? (removed[0] as WatchRemoved) : { jobs: removed };
      },
      text: ({ jobs, cwd }, printer) => {
        for (const { before, after } of jobs) {
          const watching = watchedFolders(after);
          const stopped = watchedFolders(before).filter((folder) => !watching.includes(folder));
          const name = after.name ?? after.id;
          printer.success(
            `Stopped watching ${listOf(stopped.map(underHome))}. ` +
              (watching.length === 0
                ? `Job ${name} still keeps ${scopeLabel(rootOf(after), cwd)} up to date.`
                : `Job ${name} still watches ${listOf(watching.map(underHome))}.`),
          );
        }
      },
    }),
    list: action({
      run: async (_options, context): Promise<Listed> => ({
        watches: watches((await readConfig()).jobs),
        cwd: context.cwd,
      }),
      data: ({ watches }): WatchList => ({ watches }),
      text: ({ watches, cwd }, printer) => {
        if (watches.length === 0) {
          printer.info("No folder is published as it changes.");
          printer.hint("Run `aireg watch add <folder> --to <registry>/<namespace>` to add one.");
          return;
        }
        table(
          printer,
          [
            { header: "folder", value: (item: Watch) => underHome(item.folder) },
            { header: "to", value: (item: Watch) => item.to },
            { header: "job", value: (item: Watch) => item.jobId },
            { header: "scope", value: (item: Watch) => scopeLabel(item.root, cwd) },
          ],
          watches,
        );
      },
    }),
  },
});

/** The folder a job keeps in sync: its own, else your user scope's. */
const rootOf = (job: Job) => jobRoot(job) ?? userScopeDir();

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

function needsFolder(action: string): AiregError {
  return needsInput(
    `watch ${action}`,
    "a folder",
    action === "add"
      ? "Name it: `aireg watch add <folder> --to <registry>/<namespace>`."
      : "Name it: `aireg watch remove <folder>`. Run `aireg watch list` to see them.",
  );
}

interface Changed {
  before: Job;
  after: Job;
}

interface Unwatched {
  jobs: Changed[];
  cwd: string;
}

async function remove(
  context: CommandContext,
  folders: string[],
  common: CommonOptions,
): Promise<Changed[]> {
  if (folders.length === 0) throw needsFolder("remove");
  const scope = scopeRoots(common, context.cwd, "user");
  const found = byJob((await readConfig()).jobs, folders, scope, context.cwd);
  const changed: Changed[] = [];
  for (const [job, dropped] of found) changed.push(await unwatch(job, dropped));
  return changed;
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
async function unwatch(job: Job, dropped: ReadonlySet<string>): Promise<Changed> {
  return withDaemon((client) =>
    withFreshConfig(client, async (config) => {
      const before = jobNamed(config, job.id);
      const after = withoutFolders(before, dropped);
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { upsert: [after] },
      });
      return { before, after };
    }),
  );
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
