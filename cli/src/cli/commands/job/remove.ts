import { isAbsolute, resolve } from "node:path";
import { list as listOf, quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { existing, jobNamed, needsJob } from "#cli/commands/job/find.ts";
import { underHome } from "#cli/render/home.ts";
import { type Job, type RegistryConfig, type Step, watchedFolders } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { readManifest } from "#core/manifest.ts";
import { roots, scopeFor, scopeName } from "#core/store/paths.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import { withDaemon } from "#daemon/service.ts";
import { FOREGROUND_POLICY } from "#engine/foreground.ts";

/** A folder as the job stores it or a person types it, comparable either way, even once deleted. */
function key(folder: string): string {
  return canonical(resolve(expandUserPath(folder)));
}

/**
 * The job without the folders named. With none left it goes back to the job `aireg add`
 * makes: no folder step, and edits made here reported rather than published.
 */
function withoutFolders(job: Job, folders: readonly string[], cwd: string): Job {
  const watched = watchedFolders(job);
  const keys = new Set(watched.map(key));
  const named = folders.map((folder) =>
    folder.startsWith("~") || isAbsolute(folder) ? folder : resolve(cwd, folder),
  );
  const missing = named.find((folder) => !keys.has(key(folder)));
  if (missing !== undefined) {
    throw new AiregError(
      `Job ${quoted(job.name ?? job.id)} does not watch ${underHome(key(missing))}.`,
      {
        code: ErrorCode.Usage,
        hint:
          watched.length === 0
            ? "To remove the job, leave out `--watch`."
            : `Name a folder it watches: ${listOf(
                watched.map((folder) => underHome(key(folder))),
                "or",
              )}.`,
      },
    );
  }
  const dropped = new Set(named.map(key));
  const steps = job.steps.flatMap((step): Step[] => {
    if (step.kind !== "origins") return [step];
    const select = step.select.filter((selector) => !dropped.has(key(selector.from)));
    return select.length === 0 ? [] : [{ ...step, select }];
  });
  if (steps.some((step) => step.kind === "origins")) return { ...job, steps };
  const origins = job.steps.find((step) => step.kind === "origins")?.name;
  return {
    ...job,
    steps: steps.map((step) => ({
      ...step,
      needs: step.needs.filter((name) => name !== origins),
      // `--watch` turned publishing on for the folders; without them it is reported again.
      policy:
        step.kind === "publish" && step.policy === "on" ? FOREGROUND_POLICY.publish : step.policy,
    })),
  };
}

/** The folder a job keeps up to date from its registry: enabled, and pulling there. */
function pulledInto(job: Job): string | undefined {
  if (!job.schedule.enabled) return undefined;
  return job.steps.find(
    (step) => step.kind === "pull" && step.policy !== "off" && step.root !== undefined,
  )?.root;
}

/** The scope a job keeps up to date, as a person reads it from `cwd`. */
function scopeAt(root: string, cwd: string): string {
  const scope = scopeFor(root);
  return scope === "project" && key(cwd) !== key(root)
    ? `the project at ${underHome(root)}`
    : scopeName(scope);
}

/** After a job is removed, says when nothing keeps what it kept up to date any more. */
async function warnUnkept(context: CommandContext, job: Job, after: RegistryConfig): Promise<void> {
  const registry = after.accounts.find((account) => account.id === job.account)?.registry;
  const root = pulledInto(job);
  if (registry === undefined || root === undefined) return;
  const scope = scopeFor(root);
  let installs: boolean;
  try {
    const manifest = await readManifest(roots(scope, root).manifest);
    installs = manifest.artifacts.some((ref) => ref.registry === registry);
  } catch {
    // The job is already removed; a manifest that cannot be read only costs the warning.
    return;
  }
  if (!installs) return;
  const here = scope === "project" && key(context.cwd) === key(root);
  context.printer.warning(
    `Artifacts from ${registry} in ${scopeAt(root, context.cwd)} are no longer kept up to date in the background.`,
  );
  const again = `aireg job add${scope === "user" ? " -g" : ""} --registry ${registry}`;
  context.printer.hint(
    scope === "project" && !here
      ? `To keep them up to date, run \`${again}\` in ${underHome(root)}.`
      : `To keep them up to date, run \`${again}\`.`,
  );
  if (watchedFolders(job).length > 0) {
    context.printer.hint(
      "Next time, to stop only watching a folder, run `aireg job remove <job> --watch <folder>`.",
    );
  }
}

/** Removes a job, or with `--watch` only stops it watching those folders. */
export async function remove(
  context: CommandContext,
  wanted: string | undefined,
  folders: string[] | undefined,
): Promise<void> {
  if (wanted === undefined) throw needsJob("remove");
  if (folders !== undefined && folders.length > 0) return unwatch(context, wanted, folders);
  await existing(wanted);
  await withDaemon(async (client) => {
    const job = await withFreshConfig(client, async (config) => {
      const found = jobNamed(config, wanted);
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { remove: [found.id] },
      });
      return found;
    });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { jobId: job.id } })
      : context.printer.success(`Removed job ${job.name ?? job.id}.`);
    await warnUnkept(context, job, await readConfig());
  });
}

/** Stops watching some folders and keeps the job, which goes on keeping its scope in sync. */
async function unwatch(context: CommandContext, wanted: string, folders: string[]): Promise<void> {
  const before = jobNamed(await readConfig(), wanted);
  // Checked before the daemon starts: a folder the job does not watch does not need it.
  withoutFolders(before, folders, context.cwd);
  await withDaemon(async (client) => {
    const { found, job } = await withFreshConfig(client, async (config) => {
      const found = jobNamed(config, wanted);
      const job = withoutFolders(found, folders, context.cwd);
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { upsert: [job] },
      });
      return { found, job };
    });
    const watching = watchedFolders(job);
    if (context.printer.format === "json") {
      context.printer.json({ ok: true, data: { jobId: job.id, watching } });
      return;
    }
    const stopped = watchedFolders(found).filter((folder) => !watching.includes(folder));
    const name = job.name ?? job.id;
    const root = job.steps.find((step) => step.root !== undefined)?.root ?? context.cwd;
    context.printer.success(
      `Stopped watching ${listOf(stopped.map(underHome))}. ` +
        (watching.length === 0
          ? `Job ${name} still keeps ${scopeAt(root, context.cwd)} up to date.`
          : `Job ${name} still watches ${listOf(watching.map(underHome))}.`),
    );
  });
}
