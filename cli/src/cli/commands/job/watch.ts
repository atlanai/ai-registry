import { isAbsolute, resolve } from "node:path";
import { list as listOf, quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { underHome } from "#cli/render/home.ts";
import { expandSteps, type Job, type RegistryConfig, type Step } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { readManifest } from "#core/manifest.ts";
import { roots, scopeFor } from "#core/store/paths.ts";
import { FOREGROUND_POLICY } from "#engine/foreground.ts";

/** A folder as the job stores it or a person types it, comparable either way, even once deleted. */
function key(folder: string): string {
  return canonical(resolve(expandUserPath(folder)));
}

export function watchedBy(job: Job): string[] {
  return job.steps.flatMap((step) =>
    step.kind === "origins" ? step.select.map((selector) => selector.from) : [],
  );
}

/**
 * The job without the folders named. With none left it goes back to the job `aireg add`
 * makes: no folder step, and edits made here reported rather than published.
 */
export function withoutFolders(job: Job, folders: readonly string[], cwd: string): Job {
  const watched = watchedBy(job);
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
  return expandSteps(job.steps).find(
    (step) => step.kind === "pull" && step.policy !== "off" && step.root !== undefined,
  )?.root;
}

/** The scope a job keeps up to date, as a person reads it. */
export function scopeName(root: string, cwd: string): string {
  if (scopeFor(root) === "user") return "your user scope";
  return key(cwd) === key(root) ? "this project" : `the project at ${underHome(root)}`;
}

/** After a job is removed, says when nothing keeps what it kept up to date any more. */
export async function warnUnkept(
  context: CommandContext,
  job: Job,
  after: RegistryConfig,
): Promise<void> {
  const registry = after.accounts.find((account) => account.id === job.account)?.registry;
  const root = pulledInto(job);
  if (registry === undefined || root === undefined) return;
  const still = after.jobs.some((other) => {
    const at = other.account === job.account ? pulledInto(other) : undefined;
    return at !== undefined && key(at) === key(root);
  });
  if (still) return;
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
    `Artifacts from ${registry} in ${scopeName(root, context.cwd)} are no longer kept up to date in the background.`,
  );
  const again = `aireg job add${scope === "user" ? " -g" : ""} --registry ${registry}`;
  context.printer.hint(
    scope === "project" && !here
      ? `To keep them up to date, run \`${again}\` in ${underHome(root)}.`
      : `To keep them up to date, run \`${again}\`.`,
  );
  if (watchedBy(job).length > 0) {
    context.printer.hint(
      "Next time, to stop only watching a folder, run `aireg job remove <job> --watch <folder>`.",
    );
  }
}
