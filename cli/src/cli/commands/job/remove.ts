import type { CommandContext } from "#cli/commands/command.ts";
import { existing, folderKey, jobNamed, needsJob, scopeLabel } from "#cli/commands/job/find.ts";
import { underHome } from "#cli/render/home.ts";
import { watchedFolders } from "#core/config/jobs.ts";
import type { Job, RegistryConfig } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { roots, scopeFlag, scopeFor } from "#core/store/paths.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";

/** Removes a job; `aireg watch remove` stops only its folders and keeps it. */
export async function remove(context: CommandContext, wanted: string | undefined): Promise<void> {
  if (wanted === undefined) throw needsJob("remove");
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

/** The folder a job keeps up to date from its registry: enabled, and pulling there. */
function pulledInto(job: Job): string | undefined {
  if (!job.schedule.enabled) return undefined;
  return job.steps.find(
    (step) => step.kind === "pull" && step.policy !== "off" && step.root !== undefined,
  )?.root;
}
