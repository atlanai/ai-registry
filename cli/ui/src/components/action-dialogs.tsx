import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { UiArtifact } from "../../../src/cli/ui/protocol.ts";
import { rpc } from "../lib/rpc.ts";
import { ErrorNote } from "./error-note.tsx";
import { RunLog } from "./run-log.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogClose, DialogContent } from "./ui/dialog.tsx";

function consequences(artifact: UiArtifact): string[] {
  const said = [`Deletes the installed copy of ${artifact.name}.`];
  for (const link of artifact.links) said.push(`Unlinks it from ${link.target} (${link.path}).`);
  if (artifact.links.length === 0) said.push("No target links it, so no agent loses it.");
  return said;
}

export function RemoveDialog({
  artifact,
  onClose,
}: {
  artifact: UiArtifact | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: (key: string) => rpc("remove.start", { key }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["state"] }),
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={artifact !== undefined} onOpenChange={(open) => !open && close()}>
      {artifact !== undefined && (
        <DialogContent
          title={`Remove ${artifact.name}`}
          className="w-[min(540px,calc(100vw-48px))] [&>div:last-child]:gap-4"
        >
          {remove.data === undefined ? (
            <div className="rounded-lg border border-hairline bg-subtle px-3.5 py-3">
              <span className="text-[12.5px] text-muted">What happens</span>
              <div className="mt-1 flex flex-col gap-1 text-[12px] text-ink">
                {consequences(artifact).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </div>
            </div>
          ) : (
            <RunLog runId={remove.data.runId} command={remove.data.command} title="Removing" />
          )}
          {remove.isError && <ErrorNote error={remove.error} />}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button>{remove.data === undefined ? "Cancel" : "Close"}</Button>
            </DialogClose>
            {remove.data === undefined && (
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(artifact.key)}
              >
                {remove.isPending ? "Removing…" : "Remove"}
              </Button>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function SyncBody() {
  const client = useQueryClient();
  const sync = useMutation({
    mutationFn: () => rpc("sync.start", {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["state"] }),
  });
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    sync.mutate();
  }, [sync]);
  return (
    <>
      <p className="text-[13px] leading-normal text-ink-2">
        Brings every installed artifact back in line with its registry and the lockfile.
      </p>
      {sync.isPending && <p className="text-[12px] text-muted">Starting…</p>}
      {sync.isError && <ErrorNote error={sync.error} />}
      {sync.data !== undefined && (
        <RunLog runId={sync.data.runId} command={sync.data.command} title="Sync" />
      )}
    </>
  );
}

export function SyncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && (
        <DialogContent title="Sync now" tag="aireg sync">
          <SyncBody />
        </DialogContent>
      )}
    </Dialog>
  );
}
