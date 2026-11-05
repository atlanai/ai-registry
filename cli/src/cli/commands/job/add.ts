import { resolve } from "node:path";
import { list as listOf } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { addContributedJob } from "#cli/commands/job/contributed.ts";
import { underHome } from "#cli/render/home.ts";
import { adapterFor, declaredLayout } from "#core/adapter/load.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { readOnlyLayout } from "#core/adapter/read-only.ts";
import { watchedFolders } from "#core/config/jobs.ts";
import type { Job } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { stepForFlags } from "#core/host/load.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { roots, userScopeDir } from "#core/store/paths.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import type { CommonOptions } from "#engine/options.ts";
import { cannotPublish } from "#engine/publish/target.ts";
import { originsOf, target } from "./list.ts";
import { interval, type Own, policy, refsFrom } from "./options.ts";

/** `aireg job add`, and `aireg watch add`, which is the same with only its folders. */
export async function add(
  context: CommandContext,
  root: string | undefined,
  own: Own,
  common: CommonOptions,
): Promise<void> {
  const contribution = await stepForFlags(own);
  const seconds = interval(own.interval);
  if (contribution !== undefined) {
    const flags = { ...own, targets: common.targets };
    return withDaemon((client) => addContributedJob(context, client, contribution, flags, seconds));
  }
  const planned = await plannedJob(context, root, own, common);
  const { origins, refs } = planned;
  return withDaemon(async (client) => {
    const {
      config: updated,
      job,
      existed,
    } = await withFreshConfig(client, async (config) => {
      // Your own folders are there to be published; a flag still says otherwise.
      const made = await client.request("job.create", {
        expectedRevision: config.revision,
        root: planned.jobRoot,
        scope: planned.scope,
        registry: planned.alias,
        config: planned.source.config,
        ...(refs === undefined ? {} : { refs }),
        declaredOnly: true,
        ...(origins === undefined ? {} : { origins }),
        ...(own.name === undefined ? {} : { name: own.name }),
        intervalSeconds: seconds,
        policy: {
          ...(origins === undefined ? {} : { publish: "on" as const }),
          ...planned.policy,
        },
      });
      return { ...made, existed: config.jobs.some((item) => item.id === made.job.id) };
    });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { job, revision: updated.revision } })
      : context.printer.success(saved(job, existed));
  });
}

/** What `job add` checks on its own, so a command that fails it never starts the daemon. */
async function plannedJob(
  context: CommandContext,
  root: string | undefined,
  own: Own,
  common: CommonOptions,
) {
  const origins = originsOf(own, context.cwd);
  const alias = own.registry ?? origins?.to.split("/")[0];
  if (alias === undefined) {
    throw new AiregError("`aireg job add` needs --registry, or --watch with --to.", {
      code: ErrorCode.Usage,
      hint:
        "Name the registry: `aireg job add --registry <registry>`, " +
        "or `aireg job add --watch <folder> --to <registry>/<namespace>`.",
    });
  }
  const scope = common.scope ?? "project";
  const jobRoot = scope === "user" ? userScopeDir() : resolve(context.cwd, root ?? ".");
  const manifest = await readManifest(roots(scope, jobRoot).manifest);
  const source = manifest.registries[alias];
  if (source === undefined) throw unknownRegistry(alias, scope, Object.keys(manifest.registries));
  if (origins !== undefined) {
    const laidOut = readOnlyLayout(alias, source.config);
    if (laidOut !== undefined) throw laidOut;
    const adapter = await adapterFor(
      expandLocation(source.location, jobRoot),
      source.adapter,
      declaredLayout(source.config),
    );
    if (!adapter.capabilities.publish) throw cannotPublish(adapter, alias);
  }
  const refs = await refsFrom(common, alias, manifest.registries, jobRoot);
  return { origins, alias, scope, jobRoot, source, refs, policy: policy(own) };
}

/** What the job does now; one replaced under the id it had is updated, not added. */
function saved(job: Job, existed: boolean): string {
  const verb = existed ? "Updated" : "Added";
  const to = job.steps.find((step) => step.kind === "origins")?.to;
  const watched = watchedFolders(job).map(underHome);
  if (to !== undefined && watched.length > 0) {
    return `${verb} job ${job.id}, which publishes ${listOf(watched)} to ${to}.`;
  }
  return `${verb} job ${job.id}, which syncs ${target(job)}.`;
}
