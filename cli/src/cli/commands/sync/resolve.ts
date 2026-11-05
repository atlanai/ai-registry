import { actionOf, type CommandContext } from "#cli/commands/command.ts";
import { defineCommand, STREAMED } from "#cli/commands/define.ts";
import { attentionHints, type Followed, follow, stoppedError } from "#cli/commands/sync/follow.ts";
import type { SyncResolved } from "#cli/commands/sync/result.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { loadAdapter } from "#core/adapter/load.ts";
import { findJob } from "#core/config/jobs.ts";
import type { Job } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { registryToken } from "#core/env.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { readLock } from "#core/lock.ts";
import { roots, scopeFor } from "#core/store/paths.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import type { RpcClient } from "#daemon/rpc/client.ts";
import { matchInstalled, rowsNamed } from "#engine/installed-names.ts";
import type { CommonOptions } from "#engine/options.ts";
import { cannotPublish } from "#engine/publish/target.ts";
import { load } from "#engine/scope/load.ts";
import { FOREGROUND_POLICY } from "#engine/sync/work.ts";
import { SYNC_COMMAND } from "./spec.ts";

interface Own extends Record<string, unknown> {
  mine?: boolean;
  theirs?: boolean;
  job?: string;
}

interface Options {
  common: CommonOptions;
  name: string;
  resolution: "mine" | "theirs";
  job: string | undefined;
}

// Each item prints as the daemon settles it.
export const { run } = defineCommand({
  spec: SYNC_COMMAND,
  parse(argv): Options {
    const { common, positionals, own } = parse<Own>(argv, actionOf(SYNC_COMMAND, "resolve"));
    const name = positionals[0];
    if (name === undefined) {
      throw needsInput(
        "sync resolve",
        "an artifact name",
        "Name it: `aireg sync resolve <name> --mine | --theirs`, with `--job <job>` for one a job left waiting.",
      );
    }
    if (own.mine === own.theirs) {
      throw needsInput(
        "sync resolve",
        "exactly one of --mine or --theirs",
        "Pass `--mine` to publish your copy as a new version, or `--theirs` to take the registry's copy.",
      );
    }
    return { common, name, resolution: own.mine === true ? "mine" : "theirs", job: own.job };
  },
  async run(options, context) {
    await resolve(context, options);
    return STREAMED;
  },
  text: () => {},
});

async function resolve(
  context: CommandContext,
  { common, name, resolution, job: named }: Options,
): Promise<void> {
  await withDaemon(async (client) => {
    // Unnamed means this scope, whose job was built for the conflict's run and never stored.
    if (named !== undefined) {
      const config = await readConfig();
      const job = findJob(config, named);
      const { run: started } = await client.request("conflict.resolve", {
        jobId: job?.id ?? named,
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
  // An unknown name goes as typed: the daemon says which job it looked in.
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
    const data: SyncResolved = { run: outcome.run, artifacts: outcome.artifacts };
    context.printer.json({ ok: true, data });
  }
  if (outcome.attention) context.exit = ExitCode.Changed;
  return outcome;
}
