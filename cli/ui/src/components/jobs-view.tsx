import { ChevronRight, RefreshCw } from "lucide-react";
import { Fragment, useState } from "react";
import type { UiState } from "../../../src/cli/ui/protocol.ts";
import { liveRun, useRunsVersion } from "../lib/runs.ts";
import { ago, cn, duration, every } from "../lib/utils.ts";
import { Dashboard, EmptyRow, Metric, Metrics, Section, Table } from "./dashboard.tsx";
import { RunLog } from "./run-log.tsx";
import { Badge, type Tone } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

const RUN_TONES: Record<string, Tone> = {
  succeeded: "ok",
  running: "warn",
  failed: "bad",
  cancelled: "warn",
};
const SHOWN_RUNS = 16;

function Runs({ state }: { state: UiState }) {
  useRunsVersion();
  const [open, setOpen] = useState<string>();
  const runs = state.runs.slice(0, SHOWN_RUNS);
  return (
    <Table head={["Run", "Started", "Duration", "Result"]}>
      {runs.length === 0 && (
        <EmptyRow span={4}>No runs yet. Installs, removals and syncs show up here.</EmptyRow>
      )}
      {runs.map((run) => {
        const hasLog = liveRun(run.id) !== undefined;
        const expanded = open === run.id;
        return (
          <Fragment key={run.id}>
            <tr>
              <td>
                <button
                  type="button"
                  disabled={!hasLog}
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? undefined : run.id)}
                  className="flex cursor-pointer items-center gap-1.5 text-ink disabled:cursor-default"
                  title={hasLog ? "Show its output" : run.id}
                >
                  <ChevronRight
                    className={cn(
                      "size-3 text-dim transition-transform",
                      expanded && "rotate-90",
                      !hasLog && "invisible",
                    )}
                  />
                  {run.label}
                </button>
              </td>
              <td title={new Date(run.startedAtMs).toLocaleString()}>
                <small>{ago(run.startedAtMs)}</small>
              </td>
              <td className="font-mono">
                {run.endedAtMs === undefined ? "-" : duration(run.startedAtMs, run.endedAtMs)}
              </td>
              <td>
                <Badge
                  tone={RUN_TONES[run.state] ?? "neutral"}
                  {...(run.error ? { title: run.error } : {})}
                >
                  {run.state}
                </Badge>
              </td>
            </tr>
            {expanded && (
              <tr>
                <td colSpan={4} className="bg-canvas">
                  <RunLog runId={run.id} command={undefined} title={run.label} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
      {state.runs.length > SHOWN_RUNS && (
        <EmptyRow span={4}>
          {state.runs.length - SHOWN_RUNS} more in <code className="font-mono">aireg logs</code>.
        </EmptyRow>
      )}
    </Table>
  );
}

export function JobsView({ state, onSync }: { state: UiState | undefined; onSync: () => void }) {
  if (state === undefined)
    return (
      <Dashboard title="Jobs and runs" lead="Reading aireg…">
        {null}
      </Dashboard>
    );
  const finished = state.runs.filter((run) => run.endedAtMs !== undefined);
  const failed = finished.filter((run) => run.state !== "succeeded").length;
  const interval = state.jobs.find((job) => job.intervalSeconds !== undefined)?.intervalSeconds;
  const next = state.jobs
    .map((job) => job.nextRunAtMs)
    .filter((at) => at !== undefined)
    .sort((a, b) => a - b)[0];
  return (
    <Dashboard
      title="Jobs and runs"
      lead="The background daemon runs these jobs to keep each scope up to date. Each run is recorded here."
      actions={
        <Button variant="primary" onClick={onSync}>
          <RefreshCw strokeWidth={2.2} /> Sync now
        </Button>
      }
    >
      <Metrics>
        <Metric
          label="Daemon"
          dot={state.daemon.running}
          value={state.daemon.running ? "Running" : "Stopped"}
          sub={
            state.daemon.detail || (state.daemon.running ? "" : "Start it with aireg daemon start")
          }
        />
        <Metric
          label="Sync every"
          value={every(interval)}
          sub={next === undefined ? "No scheduled runs" : `Next ${ago(next)}`}
        />
        <Metric label="Runs on record" value={state.runs.length} sub="Across every job" />
        <Metric
          label="Results"
          value={`${finished.length - failed}/${finished.length}`}
          sub={failed === 0 ? "No failures" : `${failed} did not succeed`}
        />
      </Metrics>
      <Section title="Jobs">
        <Table head={["Job", "Interval", "Next run", "Status"]}>
          {state.jobs.length === 0 && (
            <EmptyRow span={4}>
              No background job is set up. Installing for your user, with{" "}
              <code className="font-mono">aireg add -g</code>, adds one.
            </EmptyRow>
          )}
          {state.jobs.map((job) => (
            <tr key={job.id}>
              <td className="text-ink">{job.name}</td>
              <td className="font-mono">{every(job.intervalSeconds)}</td>
              <td>
                <small>
                  {job.enabled && job.nextRunAtMs !== undefined ? ago(job.nextRunAtMs) : "-"}
                </small>
              </td>
              <td>
                <Badge tone={job.enabled ? "ok" : "neutral"}>
                  {job.enabled ? "enabled" : "paused"}
                </Badge>
              </td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Recent runs" aside={`${state.runs.length} on record`}>
        <Runs state={state} />
      </Section>
    </Dashboard>
  );
}
