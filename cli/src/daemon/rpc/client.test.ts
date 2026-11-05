import { describe, expect, test } from "vitest";
import type { RunEvent } from "#core/run/model.ts";
import { RunEventType } from "#core/run/model.ts";
import { followRun, type RpcClient, RpcClientError, withFreshConfig } from "./client.ts";
import { RpcErrorCode } from "./codes.ts";

describe("withFreshConfig", () => {
  test("redoes a write against a fresh snapshot while another writer gets there first", async () => {
    let revision = 1;
    const seen: number[] = [];
    const client = {
      request: async (method: string, params: { expectedRevision?: number }) => {
        if (method === "state.snapshot") return { config: { revision } };
        seen.push(params.expectedRevision ?? -1);
        if (seen.length < 3) {
          revision += 1;
          throw new RpcClientError(
            RpcErrorCode.StaleRevision,
            "The settings changed while this command ran. Run it again.",
            {
              revision,
            },
          );
        }
        return { ok: true };
      },
    } as unknown as RpcClient;
    const result = await withFreshConfig(client, (config) =>
      client.request("settings.patch", { expectedRevision: config.revision, paused: true }),
    );
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("followRun", () => {
  const event = (id: number, eventType = "item.settled") =>
    ({ id, runId: "run_1", eventType }) as unknown as RunEvent;

  test("shows each stored and broadcast event once, in order, until the run finishes", async () => {
    let notify: (method: string, params: unknown) => void = () => {};
    const client = {
      request: async (method: string) => {
        if (method === "run.events") {
          // A broadcast that lands while the store is read is held until it is caught up.
          notify("run.event", event(2));
          return { events: [event(1), event(2)], hasMore: false };
        }
        setTimeout(() => notify("run.event", event(3, RunEventType.Finished)), 5);
        return { run: { state: "running" } };
      },
      onNotification: (listener: typeof notify) => {
        notify = listener;
        return () => {};
      },
      onClose: () => () => {},
    } as unknown as RpcClient;

    const seen: number[] = [];
    await followRun(client, "run_1", (shown) => seen.push(shown.id));
    expect(seen).toEqual([1, 2, 3]);
  });
});
