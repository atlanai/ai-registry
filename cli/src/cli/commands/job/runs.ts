import { plural, quoted } from "#adapter/text.ts";
import { action, STREAMED } from "#cli/commands/define.ts";
import type { JobOptions } from "#cli/commands/job/options.ts";
import type { JobRun, RunDetail, RunList } from "#cli/commands/job/result.ts";
import { needsInput } from "#cli/options/parse.ts";
import { underHome } from "#cli/render/home.ts";
import { eventLine, failureWords } from "#cli/render/run.ts";
import { findJob } from "#core/config/jobs.ts";
import { readConfig } from "#core/config/repository.ts";
import { failureReasons } from "#core/console/runs.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import {
  isActive,
  isTerminal,
  type RunEvent,
  RunEventType,
  type RunRecord,
  type RunState,
} from "#core/run/model.ts";
import { scopeFor } from "#core/store/paths.ts";
import { ago, duration } from "#core/term/format.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { followRun, type RpcClient, runEvents } from "#daemon/rpc/client.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";

/** `run_` plus a v4 uuid, as `runner.ts` mints them. */
const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunsOptions {
  job?: string | undefined;
  state?: RunState | undefined;
  limit?: number | undefined;
  follow?: boolean | undefined;
}

/** Why each failed run failed, which only the daemon's log kept. */
type Reasons = ReadonlyMap<string, string>;

interface Listed extends RunList {
  reasons: Reasons;
}

interface Detailed extends RunDetail {
  reasons: Reasons;
  root: string | undefined;
}

export const runs = action({
  async run(
    { argument: runId, own }: JobOptions,
    context,
  ): Promise<Listed | Detailed | typeof STREAMED> {
    if (runId !== undefined) checkRunId(runId);
    return withDaemon(async (client) => {
      if (runId !== undefined) {
        if (own.follow !== true) return detail(client, runId);
        await follow(context.printer, client, runId);
        return STREAMED;
      }
      // A job is named by its name or id; runs record the id.
      const job = own.job === undefined ? undefined : findJob(await readConfig(), own.job);
      const { state, limit } = own;
      const { runs } = await client.request("run.list", {
        ...(own.job === undefined ? {} : { jobId: job?.id ?? own.job }),
        ...(state === undefined ? {} : { state }),
        ...(limit === undefined ? {} : { limit }),
      });
      return { runs, reasons: await reasonsFor(runs) };
    });
  },
  data: (result): RunList | RunDetail =>
    "events" in result ? { run: result.run, events: result.events } : { runs: result.runs },
  text(result, printer, { own }) {
    if (!("events" in result)) {
      listText(printer, result, own.job);
      return;
    }
    printRuns(printer, [result.run], result.reasons);
    for (const event of result.events) printEvent(printer, event, result.reasons.get(event.runId));
    nextStep(printer, result.root);
  },
});

export const retry = action({
  async run({ argument }: JobOptions): Promise<JobRun> {
    const id = needsRun("retry", argument);
    return withDaemon((client) => existing(id, () => client.request("run.retry", { runId: id })));
  },
  data: ({ run }): JobRun => ({ run }),
  text: (result, printer, { argument }) =>
    printer.success(`Started run ${result.run.id} to retry ${argument}.`),
});

export const cancel = action({
  async run({ argument }: JobOptions): Promise<JobRun> {
    const id = needsRun("cancel", argument);
    return withDaemon((client) => existing(id, () => client.request("run.cancel", { runId: id })));
  },
  data: ({ run }): JobRun => ({ run }),
  text: ({ run }, printer) =>
    printer.success(
      isTerminal(run.state)
        ? `Run ${run.id} has already finished: ${run.state}.`
        : `Asked run ${run.id} to stop.`,
    ),
});

function checkRunId(word: string): void {
  if (RUN_ID.test(word)) return;
  throw new AiregError(`${quoted(word)} is not a run id.`, {
    code: ErrorCode.Usage,
    hint: "Use `aireg job runs [<run>]`, `aireg job retry <run>` or `aireg job cancel <run>`.",
  });
}

async function detail(client: RpcClient, runId: string): Promise<Detailed> {
  const { run } = await existing(runId, () => client.request("run.get", { runId }));
  const events: RunEvent[] = [];
  for await (const event of runEvents(client, runId)) events.push(event);
  const failed =
    run.errorCode !== undefined ||
    events.some(
      (event) => event.eventType === RunEventType.Finished && event.errorCode !== undefined,
    );
  const reasons = await failureReasons(new Set(failed ? [runId] : []));
  return { run, events, reasons, root: await attentionRoot(run) };
}

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

function reasonsFor(runs: readonly RunRecord[]): Promise<Map<string, string>> {
  return failureReasons(
    new Set(runs.flatMap((run) => (run.errorCode === undefined ? [] : [run.id]))),
  );
}

async function attentionRoot(run: RunRecord): Promise<string | undefined> {
  if (run.counts.attention === 0) return undefined;
  const job = run.jobId === undefined ? undefined : findJob(await readConfig(), run.jobId);
  return job?.steps.find((step) => step.root !== undefined)?.root;
}

async function follow(printer: Printer, client: RpcClient, runId: string): Promise<void> {
  const { run } = await existing(runId, () => client.request("run.get", { runId }));
  if (printer.format !== "json") printRuns(printer, [run], await reasonsFor([run]));
  let end: RunEvent | undefined;
  await followRun(client, runId, (event) => {
    if (event.eventType === RunEventType.Finished) end = event;
    else printEvent(printer, event);
  });
  if (end !== undefined) await printEnd(printer, end);
  if (printer.format === "json") return;
  const { run: ended } = await client.request("run.get", { runId });
  nextStep(printer, await attentionRoot(ended));
}

function printRuns(printer: Printer, runs: readonly RunRecord[], reasons: Reasons): void {
  const { style } = printer;
  // A run started by `aireg sync` belongs to no job; the trigger says who started it.
  table(
    printer,
    [
      { header: "run", value: (run: RunRecord) => run.id },
      { header: "state", value: (run: RunRecord) => tone(printer, run.state) },
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

function tone(printer: Printer, state: RunState): string {
  const { style } = printer;
  if (state === "succeeded") return style.green(state);
  if (state === "failed") return style.red(state);
  return isActive(state) ? style.dim(state) : style.yellow(state);
}

function took(run: RunRecord): string {
  if (run.startedAtMs === undefined || run.finishedAtMs === undefined) return "";
  return duration(run.finishedAtMs - run.startedAtMs);
}

function outcome(run: RunRecord, reasons: Reasons): string {
  if (run.errorCode !== undefined) return reasons.get(run.id) ?? failureWords(run.errorCode);
  const { examined, changed, attention } = run.counts;
  if (examined === 0) return "";
  const parts = [`${examined} checked`];
  if (changed > 0) parts.push(`${changed} changed`);
  if (attention > 0) parts.push(`${attention} need attention`);
  return parts.join(", ");
}

function printEvent(printer: Printer, event: RunEvent, reason?: string): void {
  if (printer.format === "json") {
    printer.json({ ok: true, data: { event } });
    return;
  }
  const line = eventLine(printer, event, reason);
  if (line !== undefined) printer.info(line);
}

async function printEnd(printer: Printer, event: RunEvent): Promise<void> {
  const failed = printer.format !== "json" && event.errorCode !== undefined;
  const reasons = failed ? await failureReasons(new Set([event.runId])) : undefined;
  printEvent(printer, event, reasons?.get(event.runId));
}

function nextStep(printer: Printer, root: string | undefined): void {
  if (root === undefined) return;
  printer.hint(
    scopeFor(root) === "user"
      ? "Run `aireg sync -g --dry-run` to see what each one needs."
      : `Run \`aireg sync --dry-run\` in ${underHome(root)} to see what each one needs.`,
  );
}

function listText(printer: Printer, { runs, reasons }: Listed, job: string | undefined): void {
  if (runs.length === 0) {
    printer.info(job === undefined ? "No runs yet." : `No runs of ${job} yet.`);
    if (job !== undefined) printer.hint("Run `aireg job list` to see the jobs.");
    return;
  }
  printer.info(printer.style.bold(plural(runs.length, "run")));
  printRuns(printer, runs, reasons);
}

/** Checked before connecting, so a missing or mistyped run never starts the daemon. */
function needsRun(action: string, runId: string | undefined): string {
  if (runId === undefined) {
    throw needsInput(`job ${action}`, "a run id", `Name the run: \`aireg job ${action} <run>\`.`);
  }
  checkRunId(runId);
  return runId;
}
