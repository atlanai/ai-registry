import { Activity, Plus, RefreshCw, Search } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { UiState } from "../../../src/cli/ui/protocol.ts";
import type { Live } from "../lib/events.ts";
import { installed } from "../lib/state.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/kbd.tsx";

function nextSync(state: UiState, nowMs: number): string | undefined {
  const next = state.jobs
    .filter((job) => job.enabled && job.nextRunAtMs !== undefined)
    .map((job) => job.nextRunAtMs ?? 0)
    .sort((a, b) => a - b)[0];
  if (!state.daemon.running || next === undefined) return undefined;
  const minutes = Math.ceil((next - nowMs) / 60_000);
  return minutes <= 0 ? "Sync due now" : `Next sync in ${minutes} min`;
}

function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** One quiet line instead of chips: daemon, counts, where writes go, the next sync. */
function StatusLine({ state, live }: { state: UiState | undefined; live: Live }) {
  const now = useMinute();
  if (state === undefined) return <span className="text-[12px] text-dim">Connecting…</span>;
  const ok = state.daemon.running && live === "live";
  const parts: ReactNode[] = [
    <span key="daemon" className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          ok ? "bg-pulse shadow-[0_0_0_3px_rgb(16_185_129/0.15)]" : "bg-faint",
        )}
      />
      {state.daemon.running ? "Daemon running" : "Daemon stopped"}
    </span>,
    <span key="count" className="tabular-nums">
      {state.artifacts.filter(installed).length} of {state.artifacts.length} installed
    </span>,
    <span key="root" className="min-w-0 truncate" title={state.root}>
      {state.scope === "project" ? "Project" : "User"}{" "}
      <span className="font-mono text-[11.5px]">{state.root}</span>
    </span>,
  ];
  const next = nextSync(state, now);
  if (next !== undefined) parts.push(<span key="next">{next}</span>);
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted max-xl:hidden">
      {parts.map((part, at) => (
        <Fragment key={(part as { key: string }).key}>
          {at > 0 && (
            <span aria-hidden className="text-faint">
              ·
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

export function Header({
  state,
  live,
  syncing,
  onAdd,
  onSync,
  onDoctor,
  onPalette,
}: {
  state: UiState | undefined;
  live: Live;
  syncing: boolean;
  onAdd: () => void;
  onSync: () => void;
  onDoctor: () => void;
  onPalette: () => void;
}) {
  return (
    <header className="z-40 flex h-12 min-h-12 items-center justify-between gap-6 border-b border-hairline bg-surface px-4 select-none">
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex shrink-0 cursor-default items-center gap-2">
          <div className="flex size-[22px] items-center justify-center rounded-[5px] bg-ink font-mono text-[11px] font-bold tracking-[-0.05em] text-white">
            ai
          </div>
          <span className="text-[14px] font-semibold tracking-[-0.02em] text-ink">aireg</span>
        </div>
        <StatusLine state={state} live={live} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" onClick={onPalette} aria-label="Find an artifact">
          <Search aria-hidden /> Find <Kbd>⌘K</Kbd>
        </Button>
        <Button variant="ghost" onClick={onDoctor}>
          <Activity aria-hidden /> Check setup
        </Button>
        <Button onClick={onSync} disabled={state === undefined || syncing}>
          <RefreshCw
            aria-hidden
            className={cn(syncing && "animate-spin motion-reduce:animate-none")}
          />
          {syncing ? "Syncing…" : "Sync"}
        </Button>
        <Button variant="primary" onClick={onAdd}>
          <Plus aria-hidden /> Add
        </Button>
      </div>
    </header>
  );
}
