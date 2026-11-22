import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { UiEvent } from "../../../src/cli/ui/protocol.ts";
import { rpc } from "./rpc.ts";
import { addLine, endRun } from "./runs.ts";

export type Live = "connecting" | "live" | "offline";

function parse(data: unknown): UiEvent | undefined {
  try {
    return typeof data === "string" ? (JSON.parse(data) as UiEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** One stream per tab; `state.changed` refetches, run events feed the logs. No polling. */
export function useServerEvents(client: QueryClient): Live {
  const [live, setLive] = useState<Live>("connecting");
  useEffect(() => {
    const source = new EventSource("/events");
    source.addEventListener("open", () => setLive("live"));
    source.addEventListener("state.changed", () => {
      void client.invalidateQueries({ queryKey: ["state"] });
    });
    source.addEventListener("run.event", (event) => {
      const parsed = parse(event.data);
      if (parsed?.type !== "run.event") return;
      if (parsed.eventType === "run.output") return addLine(parsed.runId, parsed.data.line);
      endRun(parsed.runId, parsed.data);
      void client.invalidateQueries({ queryKey: ["state"] });
    });
    source.addEventListener("error", () => {
      setLive("offline");
      // A closed stream is usually a lost session; one call tells, and shows the gate if so.
      if (source.readyState === EventSource.CLOSED)
        void rpc("state.snapshot", {}).catch(() => undefined);
    });
    return () => source.close();
  }, [client]);
  return live;
}
