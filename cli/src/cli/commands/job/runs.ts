import { list, plural, quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { underHome } from "#cli/render/home.ts";
import { eventLine, failureWords } from "#cli/render/run.ts";
import { findJob } from "#core/config/jobs.ts";
import { readConfig } from "#core/config/repository.ts";
import { failureReasons } from "#core/console/runs.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import {
  isActive,
  isTerminal,
  RUN_STATES,
  type RunEvent,
  type RunRecord,
  type RunState,
} from "#core/run/model.ts";
import { scopeFor } from "#core/store/paths.ts";
import { ago, duration } from "#core/term/format.ts";
import { table } from "#core/term/table.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { followRun, type RpcClient, runEvents } from "#daemon/rpc/client.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { MAX_PAGE_SIZE } from "#daemon/rpc/methods.ts";

/** `run_` plus a v4 uuid, as `runner.ts` mints them. */
const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunsOptions {
  job?: string | undefined;
  state?: string | undefined;
  limit?: string | undefined;
  follow?: boolean | undefined;
}

/** `aireg job runs [<run>]`: recent runs, or one run's events. */
export async function runs(
  context: CommandContext,
  runId: string | undefined,
  own: RunsOptions,
): Promise<void> {
  const state = own.state as RunState | undefined;
  if (state !== undefined && !RUN_STATES.includes(state)) {
    throw new AiregError(`Unknown run state ${quoted(state)}.`, {
      code: ErrorCode.Usage,
      hint: `Use ${list(RUN_STATES, "or")}.`,
    });
  }
  const limit = own.limit === undefined ? undefined : Number.parseInt(own.limit, 10);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)) {
    throw new AiregError(
      `--limit takes a whole number from 1 to ${MAX_PAGE_SIZE}, not ${quoted(own.limit as string)}.`,
      { code: ErrorCode.Usage },
    );
  }
  if (runId !== undefined) checkRunId(runId);

  await withDaemon(async (client) => {
    if (runId !== undefined) {
      await detail(context, client, runId, own.follow === true);
      return;
    }
    // A job is named by its name or id; runs record the id.
    const job = own.job === undefined ? undefined : findJob(await readConfig(), own.job);
    const { runs } = await client.request("run.list", {
      ...(own.job === undefined ? {} : { jobId: job?.id ?? own.job }),
      ...(state === undefined ? {} : { state }),
      ...(limit === undefined ? {} : { limit }),
    });
    await listRuns(context, runs, own.job);
  });
}

function checkRunId(word: string): void {
  if (RUN_ID.test(word)) return;
  throw new AiregError(`${quoted(word)} is not a run id.`, {
    code: ErrorCode.Usage,
    hint: "Use `aireg job runs [<run>]`, `aireg job retry <run>` or `aireg job cancel <run>`.",
  });
}

async function detail(
  context: CommandContext,
  client: RpcClient,
  runId: string,
  follow: boolean,
): Promise<void> {
  const { run } = await existing(runId, () => client.request("run.get", { runId }));
  if (context.printer.format !== "json") await printRuns(context, [run]);
  // Only a one-off JSON answer prints them together; following prints each as it comes.
  if (follow) {
    let end: RunEvent | undefined;
    await followRun(client, runId, (event) => {
      if (event.eventType === "run.finished") end = event;
      else printEvent(context, event);
    });
    if (end !== undefined) await printEnd(context, end);
    const { run: ended } = await client.request("run.get", { runId });
    await nextStep(context, ended);
    return;
  }
  const events: RunEvent[] = [];
  for await (const event of runEvents(client, runId)) {
    if (context.printer.format === "json") events.push(event);
    else if (event.eventType === "run.finished") await printEnd(context, event);
    else printEvent(context, event);
  }
  if (context.printer.format === "json") context.printer.json({ ok: true, data: { run, events } });
  else await nextStep(context, run);
}

/** The daemon's bare "run not found", as an error that names the run and where to look. */
async function existing<T>(runId: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if ((error as { code?: unknown }).code !== RpcErrorCode.NotFound) throw error;
    throw new AiregError(`No run named ${quoted(runId)}.`, {
      code: ErrorCode.NotFound,
      hint: "Run `aireg job runs` to see recent runs.",
    });
  }
}

async function printRuns(context: CommandContext, runs: readonly RunRecord[]): Promise<void> {
  const { style } = context.printer;
  const failed = runs.flatMap((run) => (run.errorCode === undefined ? [] : [run.id]));
  const reasons = await failureReasons(new Set(failed));
  // A run started by `aireg sync` belongs to no job; the trigger says who started it.
  table(
    context.printer,
    [
      { header: "run", value: (run: RunRecord) => run.id },
      { header: "state", value: (run: RunRecord) => tone(context, run.state) },
      { header: "mode", value: (run: RunRecord) => run.mode },
      { header: "job", value: (run: RunRecord) => run.jobId ?? style.dim("-") },
      { header: "trigger", value: (run: RunRecord) => style.dim(run.trigger) },
      { header: "started", value: (run: RunRecord) => ago(run.startedAtMs ?? run.requestedAtMs) },
      { header: "took", value: took, align: "right", optional: true },
      {
        header: "outcome",
        value: (run: RunRecord) => style.dim(outcome(run, reasons)),
        optional: true,
      },
    ],
    runs,
  );
}

function tone(context: CommandContext, state: RunState): string {
  const { style } = context.printer;
  if (state === "succeeded") return style.green(state);
  if (state === "failed") return style.red(state);
  return isActive(state) ? style.dim(state) : style.yellow(state);
}

function took(run: RunRecord): string {
  if (run.startedAtMs === undefined || run.finishedAtMs === undefined) return "";
  return duration(run.finishedAtMs - run.startedAtMs);
}

/** Why it ended, or what it did: without one of the two a state is unreadable. */
function outcome(run: RunRecord, reasons: ReadonlyMap<string, string>): string {
  if (run.errorCode !== undefined) return reasons.get(run.id) ?? failureWords(run.errorCode);
  const { examined, changed, attention } = run.counts;
  if (examined === 0) return "";
  const parts = [`${examined} checked`];
  if (changed > 0) parts.push(`${changed} changed`);
  if (attention > 0) parts.push(`${attention} need attention`);
  return parts.join(", ");
}

function printEvent(context: CommandContext, event: RunEvent, reason?: string): void {
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { event } });
    return;
  }
  const line = eventLine(context.printer, event, reason);
  if (line !== undefined) context.printer.info(line);
}

/** A failed run's last line says why, which only the daemon's log kept. */
async function printEnd(context: CommandContext, event: RunEvent): Promise<void> {
  const failed = context.printer.format !== "json" && event.errorCode !== undefined;
  const reasons = failed ? await failureReasons(new Set([event.runId])) : undefined;
  printEvent(context, event, reasons?.get(event.runId));
}

/** A run that left artifacts for a person names the dry run that says what each one needs. */
async function nextStep(context: CommandContext, run: RunRecord): Promise<void> {
  if (context.printer.format === "json" || run.counts.attention === 0) return;
  const job = run.jobId === undefined ? undefined : findJob(await readConfig(), run.jobId);
  const root = job?.steps.find((step) => step.root !== undefined)?.root;
  if (root === undefined) return;
  context.printer.hint(
    scopeFor(root) === "user"
      ? "Run `aireg sync -g --dry-run` to see what each one needs."
      : `Run \`aireg sync --dry-run\` in ${underHome(root)} to see what each one needs.`,
  );
}

async function listRuns(
  context: CommandContext,
  runs: readonly RunRecord[],
  job: string | undefined,
): Promise<void> {
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { runs } });
  } else if (runs.length === 0) {
    context.printer.info(job === undefined ? "No runs yet." : `No runs of ${job} yet.`);
    if (job !== undefined) context.printer.hint("Run `aireg job list` to see the jobs.");
  } else {
    context.printer.info(context.printer.style.bold(plural(runs.length, "run")));
    await printRuns(context, runs);
  }
}

/** `aireg job retry <run>`: run an earlier run's job again. */
export async function retry(context: CommandContext, runId: string | undefined): Promise<void> {
  const id = needsRun("retry", runId);
  await withDaemon(async (client) => {
    const { run } = await existing(id, () => client.request("run.retry", { runId: id }));
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { run } })
      : context.printer.success(`Started run ${run.id} to retry ${id}.`);
  });
}

/** Checked before connecting, so a missing or mistyped run never starts the daemon. */
function needsRun(action: string, runId: string | undefined): string {
  if (runId === undefined) {
    throw new AiregError(`\`aireg job ${action}\` needs a run id.`, {
      code: ErrorCode.Usage,
      hint: `Name the run: \`aireg job ${action} <run>\`.`,
    });
  }
  checkRunId(runId);
  return runId;
}

/** `aireg job cancel <run>`: stop a queued or running run. */
export async function cancel(context: CommandContext, runId: string | undefined): Promise<void> {
  const id = needsRun("cancel", runId);
  await withDaemon(async (client) => {
    const { run } = await existing(id, () => client.request("run.cancel", { runId: id }));
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { run } })
      : context.printer.success(
          isTerminal(run.state)
            ? `Run ${run.id} has already finished: ${run.state}.`
            : `Asked run ${run.id} to stop.`,
        );
  });
}
