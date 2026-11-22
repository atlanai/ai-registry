import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type { UiPlan, UiRunStarted } from "../../../src/cli/ui/protocol.ts";
import { rpc } from "../lib/rpc.ts";
import { useLiveRun } from "../lib/runs.ts";
import { CopyCommand } from "./copy-command.tsx";
import { ErrorNote } from "./error-note.tsx";
import { RunLog } from "./run-log.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Dialog, DialogClose, DialogContent } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";

export interface AddRequest {
  source: string;
  select: string | undefined;
}

const LABEL = "text-[12px] font-semibold text-ink";
const HINT = "text-[11px] text-muted";

function Trust({
  plan,
  trust,
  setTrust,
}: {
  plan: UiPlan;
  trust: Set<string>;
  setTrust: (next: Set<string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline bg-canvas p-3">
      <div className="text-[12px] leading-[1.45] text-ink">
        <strong>Trust plugins that run programs as you</strong>
        <div className={`${HINT} mt-0.5`}>
          The dry run names each plugin that carries MCP servers, hooks or programs that run as you;
          tick one only after you read what it runs.
        </div>
      </div>
      {plan.trustNeeded.map((need) => {
        const id = `trust-${need.plugin}`;
        return (
          <div key={need.plugin} className="flex items-start gap-2.5 pl-1">
            <span className="mt-[3px]">
              <Checkbox
                id={id}
                checked={trust.has(need.plugin)}
                onCheckedChange={(checked) => {
                  const next = new Set(trust);
                  if (checked) next.add(need.plugin);
                  else next.delete(need.plugin);
                  setTrust(next);
                }}
              />
            </span>
            <label htmlFor={id} className="cursor-pointer text-[12px] leading-[1.45] text-ink">
              <span className="font-medium">{need.plugin}</span>
              <span className="text-muted"> runs {need.carries.join(", ")}</span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

function DryRun({ plan }: { plan: UiPlan }) {
  const said = plan.changes.map(
    (change) =>
      `${change.action.padEnd(8)} ${change.name}${change.version ? `  v${change.version}` : ""}`,
  );
  return (
    <div className="flex max-h-[220px] flex-col gap-2 overflow-y-auto rounded-lg border border-white/10 bg-ink px-4 py-3.5 font-mono text-[11.5px]">
      <div className="flex items-center justify-between border-b border-white/12 pb-1.5">
        <span className="text-[12px] font-[650] text-canvas">Dry run</span>
        <Badge tone={plan.changes.length === 0 ? "neutral" : "ok"} className="text-[10px]">
          {plan.changes.length === 0 ? "Nothing to do" : "Ready"}
        </Badge>
      </div>
      <pre className="m-0 font-mono text-[11px] leading-[1.55] break-all whitespace-pre-wrap text-faint">
        {said.length > 0 ? said.join("\n") : "Nothing would change; everything is current."}
        {plan.output !== "" && `\n\n${plan.output}`}
      </pre>
    </div>
  );
}

function Done({
  started,
  first,
  onShow,
}: {
  started: UiRunStarted;
  first: string | undefined;
  onShow: (name: string) => void;
}) {
  const run = useLiveRun(started.runId);
  return (
    <>
      <RunLog runId={started.runId} command={started.command} title="Installing" />
      {run?.end !== undefined && (
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
          {run.end.ok && first !== undefined && (
            <Button variant="primary" onClick={() => onShow(first)}>
              Show it
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function AddBody({ initial, onShow }: { initial: AddRequest; onShow: (name: string) => void }) {
  const client = useQueryClient();
  const [source, setSource] = useState(initial.source);
  const [select, setSelect] = useState(initial.select ?? "");
  const [trust, setTrust] = useState<Set<string>>(new Set());
  const [started, setStarted] = useState<UiRunStarted>();
  const plan = useMutation({
    mutationFn: () => {
      const names = select.split(/[\s,]+/).filter(Boolean);
      return rpc("install.plan", {
        source: source.trim(),
        ...(names.length > 0 ? { select: names } : {}),
      });
    },
    onSuccess: () => setTrust(new Set()),
  });
  const apply = useMutation({
    mutationFn: (current: UiPlan) =>
      rpc("install.apply", { planId: current.planId, trust: [...trust] }),
    onSuccess: (run) => {
      setStarted(run);
      void client.invalidateQueries({ queryKey: ["state"] });
    },
  });
  // Any edit makes the dry run stale; only a fresh plan can be applied.
  const edit = (change: () => void) => {
    change();
    plan.reset();
  };
  const dryRun = (event: FormEvent) => {
    event.preventDefault();
    if (source.trim() !== "") plan.mutate();
  };
  if (started !== undefined) {
    return <Done started={started} first={plan.data?.changes[0]?.name} onShow={onShow} />;
  }
  return (
    <form onSubmit={dryRun} className="flex flex-col gap-3.5">
      <p className="text-[13px] leading-normal text-ink-2">
        Install skills, agents or plugins from a declared registry, a git repository, a plugin
        marketplace or a folder. Run the dry run first to see what would change.
      </p>
      <div className="flex flex-col gap-1.5">
        <label className={LABEL} htmlFor="add-source">
          Address <span className="text-[#e11d48]">*</span>
        </label>
        <Input
          id="add-source"
          autoFocus
          value={source}
          onChange={(event) => edit(() => setSource(event.target.value))}
          placeholder="e.g. acme/engineering, github.com/acme/ai-registry, or ./my-registry"
          spellCheck={false}
          className="font-mono"
        />
        <span className={HINT}>
          A declared registry and namespace, a git repository, or a folder.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className={LABEL} htmlFor="add-select">
          Only these artifacts (optional)
        </label>
        <Input
          id="add-select"
          value={select}
          onChange={(event) => edit(() => setSelect(event.target.value))}
          placeholder="e.g. pr-review, reviewer (comma-separated)"
          spellCheck={false}
          className="font-mono"
        />
        <span className={HINT}>
          Leave empty to install all artifacts, or list specific skill names.
        </span>
      </div>
      {plan.data !== undefined && plan.data.trustNeeded.length > 0 && (
        <Trust plan={plan.data} trust={trust} setTrust={setTrust} />
      )}
      {plan.isError && <ErrorNote error={plan.error} />}
      {apply.isError && <ErrorNote error={apply.error} />}
      {plan.data !== undefined && <DryRun plan={plan.data} />}
      {plan.data !== undefined && <CopyCommand command={plan.data.command} />}
      <div className="mt-2 flex items-center justify-between border-t border-hairline pt-2.5">
        <Button type="submit" disabled={source.trim() === "" || plan.isPending}>
          {plan.isPending ? "Running the dry run…" : "Dry run"}
        </Button>
        <div className="flex gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={plan.data === undefined || plan.data.changes.length === 0 || apply.isPending}
            title={plan.data === undefined ? "Run the dry run first" : undefined}
            onClick={() => plan.data !== undefined && apply.mutate(plan.data)}
          >
            Install
          </Button>
        </div>
      </div>
    </form>
  );
}

export function AddDialog({
  request,
  onClose,
  onShow,
}: {
  request: AddRequest | undefined;
  onClose: () => void;
  onShow: (name: string) => void;
}) {
  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => !open && onClose()}>
      {request !== undefined && (
        <DialogContent
          title="Add artifacts"
          tag="aireg add"
          className="max-h-[88vh] w-[min(620px,calc(100vw-48px))]"
        >
          <AddBody initial={request} onShow={onShow} />
        </DialogContent>
      )}
    </Dialog>
  );
}
