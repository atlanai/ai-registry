import { resolve } from "node:path";
import { list as listOf, plural, quoted } from "#adapter/text.ts";
import { qualify } from "#cli/commands/add.ts";
import { addContributedJob } from "#cli/commands/job/contributed.ts";
import { existing, jobNamed, needsJob, noJob, typedFolder } from "#cli/commands/job/find.ts";
import type { RunsOptions } from "#cli/commands/job/runs.ts";
import { parse } from "#cli/options.ts";
import { cannotPublish } from "#cli/publish/target.ts";
import { underHome } from "#cli/render/home.ts";
import { probeAddress, throughManifest } from "#cli/source.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor, declaredLayout } from "#core/adapter/registry.ts";
import { readOnlyLayout } from "#core/adapter/writable.ts";
import { MINIMUM_INTERVAL_SECONDS } from "#core/config/job.ts";
import {
  DEFAULT_INTERVAL_SECONDS,
  findJob,
  isStepPolicy,
  type Job,
  STEP_POLICIES,
  type StepPolicy,
  watchedFolders,
} from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { contributedStepFlags, stepContribution, stepForFlags } from "#core/host/load.ts";
import { type RegistrySource, readManifest, unknownRegistry } from "#core/manifest.ts";
import { isRunMode, RUN_MODES } from "#core/run/model.ts";
import { roots, userScopeDir } from "#core/store/paths.ts";
import { shortDuration } from "#core/term/format.ts";
import { table } from "#core/term/table.ts";
import { withFreshConfig } from "#daemon/rpc/client.ts";
import { withDaemon } from "#daemon/service.ts";
import type { CommonOptions } from "#engine/options.ts";
import { builtin, type CommandContext, runAction } from "./index.ts";

interface Own extends Record<string, unknown>, RunsOptions {
  account?: string;
  registry?: string;
  name?: string;
  interval?: string;
  pull?: string;
  publish?: string;
  delete?: string;
  adopt?: string;
  claim?: string;
  mode?: string;
  kind?: string;
  watch?: string[];
  to?: string;
}

function stepPolicy(value: string | undefined, flag: string): StepPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isStepPolicy(value))
    throw new AiregError(`${flag} takes ${listOf(STEP_POLICIES, "or")}, not ${quoted(value)}.`, {
      code: ErrorCode.Usage,
      hint: `Pass \`${flag} on\` to act, \`${flag} report\` to only say what it finds, or \`${flag} off\`.`,
    });
  return value;
}

function interval(value: string | undefined): number {
  const text = value ?? String(DEFAULT_INTERVAL_SECONDS);
  const seconds = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < MINIMUM_INTERVAL_SECONDS) {
    throw new AiregError(
      `--interval must be a whole number of seconds, at least ${MINIMUM_INTERVAL_SECONDS}.`,
      {
        code: ErrorCode.Usage,
        hint: `Pass seconds, such as \`--interval ${DEFAULT_INTERVAL_SECONDS}\`.`,
      },
    );
  }
  return seconds;
}

/** Only what the flags asked for; each leaf step takes its own. */
function policy(own: Own): Record<string, string> {
  const pull = stepPolicy(own.pull, "--pull");
  const publish = stepPolicy(own.publish, "--publish");
  const removal = stepPolicy(own.delete, "--delete");
  const adopt = stepPolicy(own.adopt, "--adopt");
  const claim = stepPolicy(own.claim, "--claim");
  return {
    ...(pull === undefined ? {} : { pull }),
    ...(publish === undefined ? {} : { publish }),
    ...(removal === undefined ? {} : { delete: removal }),
    ...(adopt === undefined ? {} : { adopt }),
    ...(claim === undefined ? {} : { claim }),
  };
}

/**
 * `-s` names inside the registry, each as the full address the manifest records, so a
 * bare name never reads as a registry of its own. Absent declares nothing.
 */
async function refsFrom(
  common: CommonOptions,
  alias: string,
  source: RegistrySource,
  base: string,
): Promise<string[] | undefined> {
  if (common.select === undefined || common.select.includes("*")) return undefined;
  const read = await probeAddress(throughManifest(alias, { [alias]: source }, {}), base, []);
  try {
    const addresses = qualify(common.select, alias, read.catalog.entries, false, alias);
    return addresses.map((address) => `${alias}/${address}`);
  } finally {
    await read.close();
  }
}

async function list(context: CommandContext): Promise<void> {
  const config = await readConfig();
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { paused: config.paused, jobs: config.jobs } });
    return;
  }
  if (config.paused) context.printer.info("Jobs are paused, so none runs on its schedule.");
  if (config.jobs.length === 0) {
    context.printer.info("No jobs yet.");
    context.printer.hint("Run `aireg job add` to add one.");
    return;
  }
  const named = new Map(config.accounts.map((item) => [item.id, item.registry]));
  const rows = await Promise.all(config.jobs.map((job) => describe(job, named)));
  const { style } = context.printer;
  context.printer.info(style.bold(plural(rows.length, "job")));
  table(
    context.printer,
    [
      { header: "job", value: (row: Described) => row.job },
      { header: "registry", value: (row: Described) => row.registry },
      { header: "folder", value: (row: Described) => row.root },
      { header: "every", value: (row: Described) => shortDuration(row.every) },
      {
        header: "state",
        value: (row: Described) =>
          row.enabled ? style.green("enabled") : style.yellow("disabled"),
      },
      { header: "steps", value: (row: Described) => style.dim(row.steps) },
    ],
    rows,
  );
}

interface Described {
  job: string;
  registry: string;
  root: string;
  every: number;
  enabled: boolean;
  steps: string;
}

/** Where a job works: the folders it watches, its first rooted step, or its kinds. */
function target(job: Job): string {
  const watched = watchedFolders(job).map(underHome);
  if (watched.length > 0) return watched.join(", ");
  const rooted = job.steps.find((step) => step.root !== undefined);
  return rooted?.root === undefined
    ? job.steps.map((step) => step.kind).join("+")
    : underHome(rooted.root);
}

async function describe(job: Job, named: ReadonlyMap<string, string>): Promise<Described> {
  const registry = named.get(job.account) ?? job.account;
  const steps = await Promise.all(
    job.steps.map(async (step) => {
      const handler = await stepContribution(step.kind);
      return handler?.describe === undefined ? step.name : handler.describe(step, registry);
    }),
  );
  return {
    job: job.name ?? job.id,
    registry,
    root: target(job),
    every: job.schedule.every,
    enabled: job.schedule.enabled,
    steps: steps.join(" → "),
  };
}

/** `--watch` folders, published to `--to`; `~` is kept for the daemon to expand. */
function originsOf(own: Own, cwd: string): { to: string; from: string[] } | undefined {
  const watched = own.watch ?? [];
  if (watched.length === 0) return undefined;
  if (own.to === undefined || !/^[^/\s]+\/[^/\s]+$/.test(own.to)) {
    throw new AiregError("--watch needs --to <registry>/<namespace>.", {
      code: ErrorCode.Usage,
      hint: "Name where to publish: `aireg job add --watch <folder> --to <registry>/<namespace>`.",
    });
  }
  return { to: own.to, from: watched.map((folder) => typedFolder(folder, cwd)) };
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
  const refs = await refsFrom(common, alias, source, jobRoot);
  return { origins, alias, scope, jobRoot, source, refs, policy: policy(own) };
}

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
        // Your own folders are there to be published; a flag still says otherwise.
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

/**
 * One execution of a job, started by a person rather than by the schedule. A job
 * whose schedule is disabled exists for exactly this.
 */
async function start(
  context: CommandContext,
  wanted: string | undefined,
  requestedMode: string | undefined,
): Promise<void> {
  if (wanted === undefined) throw needsJob("start");
  const config = await readConfig();
  const job = findJob(config, wanted);
  if (job === undefined) {
    const known = config.jobs.map((entry) => entry.name ?? entry.id);
    throw noJob(
      wanted,
      known.length === 0 ? "Run `aireg job add` to add one." : `The jobs are ${listOf(known)}.`,
    );
  }
  const mode = requestedMode ?? "sync";
  if (!isRunMode(mode)) {
    throw new AiregError(`--mode takes ${listOf(RUN_MODES, "or")}, not ${quoted(mode)}.`, {
      code: ErrorCode.Usage,
      hint: "Leave out `--mode` for a sync.",
    });
  }

  await withDaemon(async (client) => {
    const { run } = await client.request("run.start", {
      jobId: job.id,
      mode,
    });
    if (context.printer.format === "json") {
      context.printer.json({ ok: true, data: { run } });
      return;
    }
    context.printer.success(`Started job ${job.name ?? job.id} as run ${run.id}.`);
    context.printer.info(
      context.printer.style.dim(
        `Follow it with \`aireg job runs ${run.id} --follow\` or \`aireg console\`.`,
      ),
    );
  });
}

async function setEnabled(
  context: CommandContext,
  wanted: string | undefined,
  enabled: boolean,
): Promise<void> {
  const action = enabled ? "enable" : "disable";
  if (wanted === undefined) throw needsJob(action);
  await existing(wanted);
  await withDaemon(async (client) => {
    const job = await withFreshConfig(client, async (config) => {
      const found = jobNamed(config, wanted);
      await client.request("settings.patch", {
        expectedRevision: config.revision,
        jobs: { upsert: [{ ...found, schedule: { ...found.schedule, enabled } }] },
      });
      return found;
    });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { jobId: job.id, enabled } })
      : context.printer.success(`${enabled ? "Enabled" : "Disabled"} job ${job.name ?? job.id}.`);
  });
}

async function setPaused(
  context: CommandContext,
  paused: boolean,
  argument: string | undefined,
): Promise<void> {
  if (argument !== undefined) {
    const action = paused ? "pause" : "resume";
    throw new AiregError(
      `\`aireg job ${action}\` takes no job name; it ${paused ? "pauses" : "resumes"} every job.`,
      {
        code: ErrorCode.Usage,
        hint: `To ${paused ? "disable" : "enable"} one job, run \`aireg job ${paused ? "disable" : "enable"} ${argument}\`.`,
      },
    );
  }
  await withDaemon(async (client) => {
    const updated = await withFreshConfig(client, (config) =>
      client.request("settings.patch", { expectedRevision: config.revision, paused }),
    );
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { paused, revision: updated.config.revision } })
      : context.printer.success(paused ? "Paused every job." : "Resumed every job.");
  });
}

export async function run(context: CommandContext): Promise<void> {
  const extra = await contributedStepFlags();
  const spec = builtin("job");
  const { positionals, own, common } = parse<Own>(context.argv, spec, extra);
  const [action = "list", argument] = positionals;
  return runAction(spec, action, {
    list: () => list(context),
    add: () => add(context, argument, own, common),
    remove: async () => (await import("#cli/commands/job/remove.ts")).remove(context, argument),
    start: () => start(context, argument, own.mode),
    enable: () => setEnabled(context, argument, true),
    disable: () => setEnabled(context, argument, false),
    pause: () => setPaused(context, true, argument),
    resume: () => setPaused(context, false, argument),
    runs: async () => (await import("#cli/commands/job/runs.ts")).runs(context, argument, own),
    retry: async () => (await import("#cli/commands/job/runs.ts")).retry(context, argument),
    cancel: async () => (await import("#cli/commands/job/runs.ts")).cancel(context, argument),
  });
}
