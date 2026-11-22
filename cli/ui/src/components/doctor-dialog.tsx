import { useQuery } from "@tanstack/react-query";
import { rpc } from "../lib/rpc.ts";
import { ErrorNote } from "./error-note.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent } from "./ui/dialog.tsx";

function DoctorBody() {
  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: () => rpc("doctor.run", {}),
    staleTime: 0,
    gcTime: 0,
  });
  if (doctor.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 p-5 text-[12px] text-muted">
        <div className="size-[18px] animate-spin rounded-full border-2 border-hairline border-t-ink" />
        Running aireg doctor…
      </div>
    );
  }
  if (doctor.isError) return <ErrorNote error={doctor.error} />;
  const failing = doctor.data.checks.filter((check) => !check.ok).length;
  return (
    <>
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={doctor.data.ok ? "ok" : "bad"}>
          {doctor.data.ok
            ? "All checks pass"
            : `${failing} check${failing === 1 ? "" : "s"} failing`}
        </Badge>
        <Button
          className="ml-auto"
          onClick={() => void doctor.refetch()}
          disabled={doctor.isFetching}
        >
          Run again
        </Button>
      </div>
      {doctor.data.checks.map((check) => (
        <div
          key={check.name}
          className="flex items-center justify-between gap-4 rounded-md border border-hairline bg-subtle px-3 py-[9px]"
        >
          <div className="min-w-0">
            <div className="font-mono text-[11.5px] font-semibold text-ink">{check.name}</div>
            {check.detail !== "" && (
              <div className="mt-0.5 font-mono text-[11.5px] break-words text-muted">
                {check.detail}
              </div>
            )}
          </div>
          <Badge tone={check.ok ? "ok" : "bad"}>{check.ok ? "ok" : "failed"}</Badge>
        </div>
      ))}
      {doctor.data.output !== "" && (
        <details className="mt-1 text-[12px]">
          <summary className="cursor-pointer text-muted">Full output</summary>
          <pre className="mt-2 overflow-auto rounded-lg bg-ink px-4 py-3 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-faint">
            {doctor.data.output}
          </pre>
        </details>
      )}
    </>
  );
}

export function DoctorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && (
        <DialogContent title="aireg doctor & daemon diagnostic" tag="aireg doctor">
          <DoctorBody />
        </DialogContent>
      )}
    </Dialog>
  );
}
