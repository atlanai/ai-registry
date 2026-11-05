import { messageOf } from "#adapter/errors.ts";
import { list as listOf, plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { action } from "#cli/commands/define.ts";
import { jobsClause, registryJobs, removeJobs } from "#cli/commands/registry/dependent-jobs.ts";
import type { RegistryRemoved } from "#cli/commands/registry/result.ts";
import { needsInput } from "#cli/options/parse.ts";
import { noteUserScope } from "#cli/render/where.ts";
import { emptyRegistryConfig, type Job, type RegistryConfig } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Lock } from "#core/lock.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import { reaches } from "#core/manifest/match.ts";
import { writeManifest } from "#core/manifest/repository.ts";
import { formatRef, type Ref } from "#core/ref.ts";
import { type Loaded, load, withScope } from "#engine/scope/load.ts";
import type { Options } from "./options.ts";

interface Removed {
  data: RegistryRemoved;
  jobs: Job[];
  cwd: string;
}

export const remove = action({
  async run({ argument: alias, common }: Options, context): Promise<Removed> {
    if (alias === undefined) {
      throw needsInput(
        "registry remove",
        "a registry name",
        "Name the registry: `aireg registry remove <registry>`.",
      );
    }

    const loaded = await load(common, context.cwd, "user");
    const { manifest } = loaded;
    if (manifest.registries[alias] === undefined) {
      throw unknownRegistry(alias, loaded.roots.scope, Object.keys(manifest.registries));
    }
    refuseDependents(loaded, alias);

    const jobs = registryJobs(await jobsConfig(context, alias), alias, loaded.roots);
    const removed = jobs.map((job) => job.id);
    const result = {
      data: { registry: alias, dryRun: common.dryRun, jobs: removed },
      jobs,
      cwd: context.cwd,
    };
    if (common.dryRun) return result;

    // The jobs go first: a job left behind fails every run once its registry is gone.
    if (removed.length > 0) await removeJobs(removed);
    await withScope(
      loaded.roots,
      async (state) => {
        // Read again under the lease, so a change another command made meanwhile is kept.
        if (state.manifest.registries[alias] === undefined) return;
        refuseDependents(state, alias);
        delete state.manifest.registries[alias];
        await writeManifest(state.roots, state.manifest);
      },
      context.printer,
    );
    return result;
  },
  data: (result) => result.data,
  text({ data, jobs, cwd }, printer, { common }) {
    const what = `registry ${data.registry}${jobsClause(jobs)}`;
    if (data.dryRun) {
      printer.info(`Would remove ${what}.`);
      printer.dryRun();
      return;
    }
    printer.success(`Removed ${what}.`);
    noteUserScope(printer, common.scope, cwd);
  },
});

/** Dropping the source of installed artifacts would leave the manifest unresolvable, so refuse. */
function refuseDependents({ manifest, lock }: Loaded, alias: string): void {
  const dependents = manifest.artifacts.filter((ref) => ref.registry === alias);
  if (dependents.length > 0) throw stillDeclared(alias, dependents, lock);
}

/** Counts what is installed, not manifest entries: an entry can cover nothing. */
function stillDeclared(alias: string, dependents: readonly Ref[], lock: Lock): AiregError {
  const installed = Object.values(lock.artifacts).filter((row) =>
    dependents.some((ref) => reaches(ref, row)),
  ).length;
  const named = listOf(dependents.map(formatRef));
  return new AiregError(
    installed > 0
      ? `Registry ${alias} still provides ${plural(installed, "installed artifact")}.`
      : `The manifest still takes ${named} from registry ${alias}.`,
    {
      code: ErrorCode.Conflict,
      hint: `Remove ${named} first with \`aireg remove\`.`,
    },
  );
}

/** Jobs live in config.yml; one this aireg cannot read leaves them as they are, and says so. */
async function jobsConfig(context: CommandContext, alias: string): Promise<RegistryConfig> {
  try {
    return await readConfig();
  } catch (error) {
    context.printer.warning(
      `Could not read your jobs, so any for registry ${alias} stays: ${messageOf(error)}`,
    );
    return emptyRegistryConfig();
  }
}
