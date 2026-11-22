import { Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { rpc } from "../lib/rpc.ts";
import { useLiveRun } from "../lib/runs.ts";
import { toast } from "../lib/toast.ts";
import { CopyCommand } from "./copy-command.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

/** The original's dark output panel, fed live by `run.event`, pinned to the bottom while it runs. */
export function RunLog({
  runId,
  command,
  title = "Output",
}: {
  runId: string;
  command: string | undefined;
  title?: string;
}) {
  const run = useLiveRun(runId);
  const bottom = useRef<HTMLDivElement>(null);
  const lines = run?.lines.length ?? 0;
  useEffect(() => {
    if (lines > 0) bottom.current?.scrollIntoView({ block: "end" });
  }, [lines]);
  const end = run?.end;
  const cancel = async () => {
    try {
      const { cancelled } = await rpc("run.cancel", { runId });
      if (!cancelled) toast("info", "The run had already finished.");
    } catch {
      toast("error", "Could not cancel the run.");
    }
  };
  let badge = <Badge tone="warn">Running</Badge>;
  if (end?.ok === true) badge = <Badge tone="ok">Done</Badge>;
  else if (end?.ok === false) {
    badge = (
      <Badge tone="bad">{end.exitCode === null ? "Failed" : `Failed, exit ${end.exitCode}`}</Badge>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-ink px-4 py-3.5 font-mono text-[11.5px]">
        <div className="flex items-center justify-between border-b border-white/12 pb-1.5">
          <span className="text-[12px] font-[650] text-canvas">{title}</span>
          {badge}
        </div>
        <div role="log" aria-live="polite" className="max-h-[220px] overflow-y-auto">
          <pre className="m-0 font-mono text-[11px] leading-[1.55] break-all whitespace-pre-wrap text-faint">
            {lines === 0 && end === undefined ? "Waiting for output…" : run?.lines.join("\n")}
          </pre>
          <div ref={bottom} />
        </div>
        {end !== undefined && end.summary !== "" && (
          <div className="border-t border-white/12 pt-1.5 text-[11px] text-canvas">
            {end.summary}
          </div>
        )}
      </div>
      {(command !== undefined || end === undefined) && (
        <div className="flex items-center gap-2">
          {command !== undefined && <CopyCommand command={command} className="min-w-0 flex-1" />}
          {end === undefined && (
            <Button onClick={() => void cancel()} className="ml-auto">
              <Square /> Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
