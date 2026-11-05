import type { ReactElement, ReactNode } from "react";
import { plural } from "#adapter/text.ts";
import { box, dim, faint, heading, plain, text } from "#cli/console/ui/elements.ts";
import { health } from "#core/console/artifacts.ts";
import type { ConsoleState } from "#core/console/model.ts";
import { bar, clock, interval, pad, truncate } from "#core/term/format.ts";
import { COLOR, GLYPH, runColor, runGlyph } from "#core/term/theme.ts";

/** The one screen that answers "is this machine in a good state" without scrolling. */
export function overviewView(props: {
  width: number;
  state: ConsoleState;
  cursor: number;
  /** A block per contributed panel, under aireg's own. */
  extra: ReactNode[];
}): ReactElement {
  const children: ReactNode[] = [
    box({ key: "h1" }, heading("local state")),
    box(
      { key: "b1", flexDirection: "column", marginBottom: 1 },
      ...localState(props.state),
      ...props.extra,
    ),
    box({ key: "h2" }, heading("namespaces")),
    box(
      { key: "b2", flexDirection: "column", marginBottom: 1 },
      ...namespaces(props.state, props.width, props.cursor),
    ),
    box({ key: "b3", flexDirection: "column", marginBottom: 1 }, ...jobs(props.state)),
    box({ key: "b4", flexDirection: "column" }, ...runs(props.state, props.width)),
  ];
  if (props.state.problems.length > 0) {
    children.push(
      box(
        { key: "problems", flexDirection: "column", marginTop: 1 },
        ...props.state.problems.map((problem, index) =>
          box({ key: `p${index}` }, text({ color: COLOR.red }, `   ! ${problem}`)),
        ),
      ),
    );
  }
  return box({ flexDirection: "column", width: props.width }, ...children);
}

function localState(state: ConsoleState): ReactElement[] {
  const s = state.summary;
  const lines: ReactElement[] = [
    statusLine(
      s.failed === 0,
      "Artifacts",
      box(
        null,
        text({ color: COLOR.white }, `${s.skillsImported}`),
        dim(" of "),
        text({ color: COLOR.white }, `${s.skillsExamined}`),
        dim(" installed"),
      ),
      box(
        null,
        s.failed > 0 ? text({ color: COLOR.red }, `      ${s.failed} failed`) : plain(""),
        s.edited > 0 ? text({ color: COLOR.yellow }, `   ${s.edited} edited`) : plain(""),
        s.dangling > 0 ? text({ color: COLOR.orange }, `   ${s.dangling} dangling`) : plain(""),
        s.pending > 0 ? text({ color: COLOR.yellow }, `   ${s.pending} pending`) : plain(""),
        s.unpublished > 0 ? dim(`   ${s.unpublished} unpublished`) : plain(""),
      ),
    ),
  ];
  return lines;
}

function statusLine(ok: boolean, label: string, value: ReactNode, extra: ReactNode): ReactElement {
  return box(
    null,
    text({ color: ok ? COLOR.green : COLOR.red }, `   ${GLYPH.bullet} `),
    text({ color: COLOR.white }, pad(label, 20)),
    value,
    extra,
  );
}

function namespaces(state: ConsoleState, width: number, cursor: number): ReactElement[] {
  const nameWidth = Math.max(18, Math.min(34, width - 70));
  const lines: ReactElement[] = [
    box(
      null,
      faint(
        `   ${pad("", nameWidth + 2)}${pad("", 16)}${pad("ARTIFACTS", 12)}` +
          `${pad("INSTALLED", 16)}STATE`,
      ),
    ),
  ];
  for (const [index, group] of state.groups.entries()) {
    const last = index === state.groups.length - 1;
    const { settled, trouble } = health(group);
    lines.push(
      box(
        {
          key: group.key,
          width: "100%",
          ...(index === cursor ? { backgroundColor: COLOR.selection } : {}),
        },
        text({ color: COLOR.faint }, `   ${last ? GLYPH.last : GLYPH.branch} `),
        text(
          { color: group.authoredHere ? COLOR.yellow : COLOR.white, bold: true },
          pad(group.label, nameWidth),
        ),
        group.isDefault
          ? text({ color: COLOR.yellow }, pad("default", 16))
          : group.authoredHere
            ? faint(pad("authored here", 16))
            : plain(" ".repeat(16)),
        text({ color: COLOR.white }, pad(String(group.rows.length), 12)),
        text(
          { color: settled === group.rows.length ? COLOR.green : COLOR.yellow },
          pad(bar(settled, group.rows.length, 12), 16),
        ),
        trouble.length > 0
          ? text({ color: COLOR.yellow }, trouble.join(" \u00b7 "))
          : text(
              { color: COLOR.green },
              group.counts.imported > 0 ? `${group.counts.imported} imported` : "ok",
            ),
      ),
    );
  }
  return lines;
}

function jobs(state: ConsoleState): ReactElement[] {
  const lines: ReactElement[] = [
    box(
      null,
      heading("daemon"),
      text(
        { color: state.daemon.running ? COLOR.green : COLOR.red },
        `  ${state.daemon.running ? "running" : "stopped"}`,
      ),
      dim(
        `  ${state.daemon.pid === undefined ? "" : `pid ${state.daemon.pid} · `}` +
          `${state.daemon.jobsEnabled} of ${plural(state.daemon.jobsTotal, "job")} enabled on this machine`,
      ),
    ),
  ];
  for (const [index, job] of state.jobs.entries()) {
    const last = index === state.jobs.length - 1;
    lines.push(
      box(
        { key: job.id },
        text({ color: COLOR.faint }, `   ${last ? GLYPH.last : GLYPH.branch} `),
        text({ color: job.enabled ? COLOR.white : COLOR.faint }, pad(job.name, 26)),
        dim(pad(job.type, 9)),
        dim(pad(interval(job.intervalSeconds), 12)),
        faint(truncate(job.summary, 44)),
        job.nextRunAtMs === undefined ? plain("") : dim(`   next ${clock(job.nextRunAtMs)}`),
      ),
    );
  }
  return lines;
}

function runs(state: ConsoleState, width: number): ReactElement[] {
  const lines: ReactElement[] = [box(null, heading("recent"))];
  if (state.runs.length === 0) lines.push(box({ key: "none" }, dim("   No runs yet.")));
  for (const run of state.runs.slice(0, 5)) {
    lines.push(
      box(
        { key: run.id },
        text({ color: runColor(run.state) }, `   ${runGlyph(run.state)} `),
        dim(pad(clock(run.requestedAtMs), 8)),
        text({ color: COLOR.white }, pad(run.mode, 9)),
        dim(pad(run.jobId ?? "-", 26)),
        run.errorCode === undefined
          ? dim(`${run.counts.examined} checked · ${run.counts.changed} changed`)
          : text({ color: COLOR.red }, run.errorCode),
        run.counts.failed > 0
          ? text({ color: COLOR.red }, ` · ${run.counts.failed} failed`)
          : plain(""),
        run.reason === undefined
          ? plain("")
          : faint(` - ${truncate(run.reason, Math.max(10, width - 74))}`),
      ),
    );
  }
  return lines;
}
