import type { CommandContext } from "#cli/commands/command.ts";
import { action } from "#cli/commands/define.ts";
import { existing, folderKey, jobNamed, needsJob, scopeLabel } from "#cli/commands/job/find.ts";
import type { JobOptions } from "#cli/commands/job/options.ts";
import type { JobRemoved } from "#cli/commands/job/result.ts";
import { underHome } from "#cli/render/home.ts";
import { watchedFolders } from "#core/config/jobs.ts";
import type { Job, RegistryConfig } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { roots, scopeFlag, scopeFor } from "#core/store/paths.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

/** `aireg watch remove` stops only a job's folders and keeps the job. */
export const remove = action({
  async run({ argument: wanted }: JobOptions, context): Promise<Job> {
    if (wanted === undefined) throw needsJob("remove");
    await existing(wanted);
    const job = await withDaemon((client) =>
      withFreshConfig(client, async (config) => {
        const found = jobNamed(config, wanted);
        await client.request("settings.patch", {
          expectedRevision: config.revision,
          jobs: { remove: [found.id] },
        });
        return found;
      }),
    );
    await warnUnkept(context, job, await readConfig());
    return job;
  },
  data: (job): JobRemoved => ({ jobId: job.id }),
  text: (job, printer) => printer.success(`Removed job ${job.name ?? job.id}.`),
});

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
  const elsewhere = scope === "project" && folderKey(context.cwd) !== folderKey(root);
  context.printer.warning(
    `Artifacts from ${registry} in ${scopeLabel(root, context.cwd)} are no longer kept up to date in the background.`,
  );
  const again = `aireg job add${scopeFlag(scope)} --registry ${registry}`;
  context.printer.hint(
    elsewhere
      ? `To keep them up to date, run \`${again}\` in ${underHome(root)}.`
      : `To keep them up to date, run \`${again}\`.`,
  );
  if (watchedFolders(job).length > 0) {
    context.printer.hint(
      "Next time, to stop only publishing a folder, run `aireg watch remove <folder>`.",
    );
  }
}

function pulledInto(job: Job): string | undefined {
  if (!job.schedule.enabled) return undefined;
  return job.steps.find(
    (step) => step.kind === "pull" && step.policy !== "off" && step.root !== undefined,
  )?.root;
}
