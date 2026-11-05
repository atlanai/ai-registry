import type { ReactElement } from "react";
import { windowAround } from "#cli/console/data/list.ts";
import { summaryStrip } from "#cli/console/ui/chrome.ts";
import { action, box, dim, faint, heading, plain, text } from "#cli/console/ui/elements.ts";
import { failureWords } from "#cli/render/run.ts";
import type { ConsoleState, JobRow, RunRow } from "#core/console/model.ts";
import { isFailed } from "#core/run/model.ts";
import { ago, clock, interval, pad, truncate } from "#core/term/format.ts";
import { COLOR, GLYPH, runColor, runGlyph } from "#core/term/theme.ts";

export type JobLine = { kind: "job"; job: JobRow } | { kind: "run"; run: RunRow };

export function jobLines(state: ConsoleState): JobLine[] {
  return [
    ...state.jobs.map((job) => ({ kind: "job" as const, job })),
    ...state.runs.map((run) => ({ kind: "run" as const, run })),
  ];
}

/** Which runs are on screen; shared with the click mapping so a click retries the run it hit. */
export function runWindow(
  lines: readonly JobLine[],
  cursor: number,
  height: number,
): ReturnType<typeof windowAround> {
  const jobs = lines.filter((line) => line.kind === "job").length;
  return windowAround(
    lines.filter((line) => line.kind === "run").length,
    Math.max(0, cursor - jobs),
    Math.max(3, height - 4 - jobs),
  );
}

export function jobsView(props: {
  width: number;
  height: number;
  state: ConsoleState;
  lines: readonly JobLine[];
  cursor: number;
}): ReactElement {
  const jobs = props.lines.filter((line) => line.kind === "job");
  const runs = props.lines.filter((line) => line.kind === "run");
  const view = runWindow(props.lines, props.cursor, props.height);

  const rendered: ReactElement[] = [];
  for (const [index, line] of jobs.entries()) {
    if (line.kind !== "job") continue;
    rendered.push(box({ key: line.job.id }, jobLine(line.job, index === props.cursor)));
  }

  const runRows: ReactElement[] = [];
  for (let index = view.from; index < view.to; index += 1) {
    const line = runs[index];
    if (line === undefined || line.kind !== "run") continue;
    runRows.push(
      box(
        { key: line.run.id },
        runLine(line.run, index + jobs.length === props.cursor, props.width),
      ),
    );
  }

  return box(
    { flexDirection: "column", width: props.width },
    box(
      { justifyContent: "space-between" },
      heading("jobs"),
      faint(props.state.daemon.running ? "daemon running" : "daemon stopped"),
    ),
    ...rendered,
    box({ marginTop: 1, justifyContent: "space-between" }, heading("runs"), faint("newest first")),
    ...runRows,
    view.below > 0 ? box(null, faint(`   … ${view.below} older`)) : box(null, plain("")),
  );
}

function jobLine(job: JobRow, selected: boolean): ReactElement {
  return box(
    {
      width: "100%",
      justifyContent: "space-between",
      ...(selected ? { backgroundColor: COLOR.selection } : {}),
    },
    box(
      null,
      text({ color: job.enabled ? COLOR.green : COLOR.faint }, `   ${GLYPH.bullet} `),
      text({ color: job.enabled ? COLOR.white : COLOR.faint }, pad(job.name, 26)),
      dim(pad(job.type, 9)),
      dim(pad(interval(job.intervalSeconds), 12)),
      faint(pad(truncate(job.summary, 46), 48)),
      text(
        { color: job.enabled ? COLOR.green : COLOR.faint },
        pad(job.enabled ? "enabled" : "disabled", 10),
      ),
      job.nextRunAtMs === undefined ? plain("") : dim(`next ${clock(job.nextRunAtMs)}`),
    ),
    box(null, action("space", job.enabled ? "disable" : "enable"), plain("  "), action("R", "run")),
  );
}

function runLine(run: RunRow, selected: boolean, width: number): ReactElement {
  const failed = isFailed(run.state);
  return box(
    {
      width: "100%",
      justifyContent: "space-between",
      ...(selected ? { backgroundColor: COLOR.selection } : {}),
    },
    box(
      null,
      text({ color: runColor(run.state) }, `   ${runGlyph(run.state)} `),
      dim(pad(clock(run.requestedAtMs), 8)),
      text({ color: COLOR.white }, pad(run.jobId ?? "manual", 26)),
      dim(pad(run.mode, 9)),
      text({ color: runColor(run.state) }, pad(run.state, 12)),
      failed
        ? text({ color: COLOR.red }, pad(failureWords(run.errorCode ?? "failed"), 18))
        : dim(
            pad(
              `${run.counts.examined} checked · ${run.counts.changed} changed` +
                (run.counts.failed > 0 ? ` · ${run.counts.failed} failed` : ""),
              Math.max(18, Math.min(52, width - 80)),
            ),
          ),
      run.reason === undefined ? plain("") : faint(truncate(run.reason, 40)),
    ),
    failed ? action("r", "retry") : plain(""),
  );
}

export function jobsSummaryStrip(props: {
  width: number;
  line: JobLine | undefined;
  nowMs: number;
}): ReactElement {
  if (props.line === undefined) {
    return summaryStrip({
      width: props.width,
      title: "Jobs",
      badge: undefined,
      lines: [],
      hint: undefined,
    });
  }
  if (props.line.kind === "job") {
    const job = props.line.job;
    return summaryStrip({
      width: props.width,
      title: job.name,
      badge: {
        label: job.enabled ? "ENABLED" : "DISABLED",
        color: job.enabled ? COLOR.green : COLOR.faint,
      },
      lines: [
        box(null, dim(`${job.type}  ·  ${interval(job.intervalSeconds)}  ·  `), faint(job.summary)),
        box(
          null,
          dim(`last run ${ago(job.lastRunAtMs, props.nowMs)}`),
          job.nextRunAtMs === undefined
            ? faint("   not scheduled")
            : dim(`   next ${clock(job.nextRunAtMs)}`),
        ),
      ],
      hint: `R run now · space ${job.enabled ? "disable" : "enable"}`,
    });
  }
  const run = props.line.run;
  return summaryStrip({
    width: props.width,
    title: run.id,
    badge: { label: run.state.toUpperCase(), color: runColor(run.state) },
    lines: [
      box(
        null,
        dim(`${run.mode} · ${run.jobId ?? "manual"} · trigger=${run.trigger}  `),
        dim(
          `${run.counts.examined} checked · ${run.counts.changed} changed · ` +
            `${run.counts.skipped} skipped · ${run.counts.attention} attention · `,
        ),
        text(
          { color: run.counts.failed > 0 ? COLOR.red : COLOR.dim },
          `${run.counts.failed} failed`,
        ),
      ),
      box(
        null,
        run.errorCode === undefined
          ? faint(`finished ${ago(run.finishedAtMs, props.nowMs)}`)
          : text(
              { color: COLOR.red },
              `${failureWords(run.errorCode)}${run.reason === undefined ? "" : `: ${truncate(run.reason, props.width - 30)}`}`,
            ),
      ),
    ],
    hint: isFailed(run.state) ? "r retry" : undefined,
  });
}
