import { actionOf, builtin, type CommandContext } from "#cli/commands/index.ts";
import { attentionHints, type Followed, follow, stoppedError } from "#cli/commands/sync/follow.ts";
import { matchInstalled, rowsNamed } from "#cli/names.ts";
import { parse } from "#cli/options.ts";
import { cannotPublish } from "#cli/publish/target.ts";
import { loadAdapter } from "#core/adapter/registry.ts";
import { findJob, type Job } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { registryToken } from "#core/env.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { readLock } from "#core/lock.ts";
import { roots, scopeFor } from "#core/store/paths.ts";
import type { RpcClient } from "#daemon/rpc/client.ts";
import { withDaemon } from "#daemon/service.ts";
import { FOREGROUND_POLICY } from "#engine/foreground.ts";
import { load } from "#engine/pipeline.ts";

interface Own extends Record<string, unknown> {
  mine?: boolean;
  theirs?: boolean;
  job?: string;
}

export async function run(context: CommandContext): Promise<void> {
  const { common, positionals, own } = parse<Own>(
    context.argv,
    actionOf(builtin("sync"), "resolve"),
  );
  const name = positionals[0];
  if (name === undefined) {
    throw new AiregError("`aireg sync resolve` needs an artifact name.", {
      code: ErrorCode.Usage,
      hint: "Name it: `aireg sync resolve <name> --mine | --theirs`, with `--job <job>` for one a job left waiting.",
    });
  }
  if (own.mine === own.theirs) {
    throw new AiregError("`aireg sync resolve` needs exactly one of --mine or --theirs.", {
      code: ErrorCode.Usage,
      hint: "Pass `--mine` to publish your copy as a new version, or `--theirs` to take the registry's copy.",
    });
  }
  const resolution = own.mine === true ? "mine" : "theirs";

  await withDaemon(async (client) => {
    // A configured job names itself; anything else is this scope, whose job was
    // built for the run that found the conflict and never stored.
    if (own.job !== undefined) {
      const config = await readConfig();
      const job = findJob(config, own.job);
      const { run: started } = await client.request("conflict.resolve", {
        jobId: job?.id ?? own.job,
        name: await jobKey(job, name),
        resolution,
      });
      const registry = config.accounts.find((account) => account.id === job?.account)?.registry;
      await settled(context, client, started.id, name, registry);
      return;
    }

    const loaded = await load(common, context.cwd);
    const { lock } = loaded;
    const [key] = rowsNamed(name, lock) as [string];
    const registry = lock.artifacts[key]?.registry as string;
    const row = lock.artifacts[key];
    const id = lock.registries[registry]?.adapter;
    const adapter = id === undefined ? undefined : await loadAdapter(id).catch(() => undefined);
    if (resolution === "mine" && adapter !== undefined && !adapter.capabilities.publish) {
      throw cannotPublish(
        adapter,
        registry,
        `aireg publish ${key} --to <folder>/${row?.namespace ?? "<namespace>"}`,
      );
    }

    const token = registryToken(registry);
    const { run: started } = await client.request("sync.resolve", {
      root: context.cwd,
      scope: loaded.roots.scope,
      registry,
      policy: FOREGROUND_POLICY,
      name: key,
      resolution,
      ...(token === undefined ? {} : { token }),
    });
    const outcome = await settled(context, client, started.id, key, registry);
    if (outcome.attention && context.printer.format !== "json") {
      const waiting = outcome.artifacts
        .filter((item) => item.outcome === "attention")
        .map((item) => ({ registry, name: item.name, disposition: item.disposition }));
      await attentionHints(context, loaded, waiting);
    }
  });
}

/** The row a name means in a job's scope, read as `sync resolve` reads it without `--job`. */
async function jobKey(job: Job | undefined, name: string): Promise<string> {
  const root = job?.steps.find((step) => step.root !== undefined)?.root;
  if (root === undefined) return name;
  const lock = await readLock(roots(scopeFor(root), root));
  // A name this scope doesn't know goes as typed: the daemon says which job it looked in.
  if (matchInstalled(name, lock).rows.length === 0) return name;
  return rowsNamed(name, lock)[0] as string;
}

/** Waits for the run, printing how the artifact settled, as `aireg sync` does. */
async function settled(
  context: CommandContext,
  client: RpcClient,
  runId: string,
  name: string,
  registry: string | undefined,
): Promise<Followed> {
  const outcome = await follow(context, client, runId, undefined, registry);
  if (outcome.stopped !== undefined) {
    const stopped = [{ name, reason: outcome.stopped }];
    throw stoppedError("Could not resolve", stopped, `aireg sync resolve ${name}`);
  }
  if (outcome.failed) {
    throw new AiregError(`Could not resolve ${name}.`, {
      code: ErrorCode.Unavailable,
      hint: `Run \`aireg job runs ${runId}\` to see how it ended.`,
    });
  }
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { run: outcome.run, artifacts: outcome.artifacts } });
  }
  if (outcome.attention) context.exit = ExitCode.Changed;
  return outcome;
}
