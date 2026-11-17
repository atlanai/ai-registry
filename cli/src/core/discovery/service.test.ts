import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { DISCOVERY_SETTINGS_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import type { Skill } from "./retrieval.ts";
import { Discovery } from "./service.ts";
import { DiscoveryStore } from "./store.ts";

const skills: Skill[] = [
  {
    key: "example/recap",
    name: "recap",
    registry: "example",
    namespace: "",
    version: "1",
    digest: "digest-one",
    description: "Summarize notes into a team recap.",
  },
  {
    key: "private/design",
    name: "design",
    registry: "private",
    namespace: "",
    version: "1",
    digest: "digest-two",
    description: "Excluded registry description",
  },
];
function provider() {
  return vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith(":embedContent"))
      return Response.json({ embedding: { values: [1, 0] } });
    const body = JSON.parse(String(options?.body));
    const choice = Object.hasOwn(body.questions.skill.criteria, "connected")
      ? "connected"
      : "candidate_0";
    return Response.json({ answers: { skill: { choice, confidence: 0.9 } } });
  });
}
async function indexed(service: Discovery) {
  await service.build(skills);
  await vi.waitFor(async () =>
    expect(await service.status(skills)).toMatchObject({ job: { running: false }, indexed: 1 }),
  );
}
const setup = { key: "synthetic-key", consent: true, registries: ["example"], telemetry: true };

describe("discovery user journey", () => {
  test("connects, indexes only approved metadata, routes, prepares a pinned handoff and persists truthful telemetry", async ({
    tmp,
  }) => {
    const env = { AIREG_HOME: join(tmp, "home") };
    const send = provider();
    const service = new Discovery(env, send);
    await service.setup(setup, skills);
    await indexed(service);
    const result = (await service.search({ query: "synthetic-private-query" }, skills)) as {
      requestId: string;
    };
    expect(await service.handoff({ requestId: result.requestId }, skills)).toMatchObject({
      handoff: { skill: { key: "example/recap", digest: "digest-one", version: "1" } },
    });
    await service.feedback({ ...result, outcome: "helpful" });
    await service.handoff({ requestId: result.requestId }, skills);
    await expect(service.feedback({ ...result, outcome: "helpful" })).rejects.toThrow(
      "already recorded",
    );
    const persisted = await readFile(join(env.AIREG_HOME, DISCOVERY_SETTINGS_FILE), "utf8");
    expect(persisted).not.toContain("synthetic-private-query");
    expect(persisted).not.toContain("synthetic-key");
    expect(persisted).not.toContain(skills[0]?.description);
    expect(JSON.parse(persisted).events.map((e: { type: string }) => e.type)).toEqual([
      "search",
      "recommendation",
      "handoff",
      "feedback",
    ]);
    expect(JSON.stringify(send.mock.calls)).not.toContain("Excluded registry description");
    expect((await stat(join(env.AIREG_HOME, DISCOVERY_SETTINGS_FILE))).mode & 0o777).toBe(0o600);
    const restarted = new Discovery(env, send);
    expect(await restarted.status(skills)).toMatchObject({ connected: true, indexed: 1 });
    const callsBeforeRestartSearch = send.mock.calls.length;
    await restarted.search({ query: "recap notes" }, skills);
    expect(send.mock.calls.length).toBe(callsBeforeRestartSearch + 2);
    await restarted.clear();
    expect(await restarted.status(skills)).toMatchObject({ events: [] });
    await restarted.disconnect();
    expect(await restarted.status(skills)).toMatchObject({ connected: false, registries: [] });
  });
  test("refuses unapproved scope without sending data and leaves failed connections unsaved", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await expect(service.setup({ ...setup, consent: false }, skills)).rejects.toThrow("approve");
    await expect(service.setup({ ...setup, registries: ["invented"] }, skills)).rejects.toThrow(
      "Choose",
    );
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(new Response("synthetic-error", { status: 403 }));
    await expect(service.setup(setup, skills)).rejects.toThrow("403");
    expect(await service.status(skills)).toMatchObject({ connected: false });
  });
  test("refuses stale catalog searches and handoffs, and reuses unchanged embeddings", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup(setup, skills);
    await indexed(service);
    const calls = send.mock.calls.length;
    await indexed(service);
    expect(send.mock.calls.length).toBe(calls);
    const result = (await service.search({ query: "recap notes" }, skills)) as {
      requestId: string;
    };
    const changed = skills.map((s) => ({ ...s, digest: "changed" }));
    await expect(service.search({ query: "recap notes" }, changed)).rejects.toThrow(
      "catalog has changed",
    );
    await expect(service.handoff(result, changed)).rejects.toThrow("stale");
  });
  test("supports abstention and paused telemetry without fabricating a handoff", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup({ ...setup, telemetry: false }, skills);
    await indexed(service);
    send
      .mockResolvedValueOnce(Response.json({ embedding: { values: [1, 0] } }))
      .mockResolvedValueOnce(
        Response.json({ answers: { skill: { choice: "none", confidence: 0.8 } } }),
      );
    const result = (await service.search({ query: "unrelated task" }, skills)) as {
      requestId: string;
    };
    expect(result).toMatchObject({ status: "none", selected: null });
    await expect(service.handoff({ requestId: result.requestId }, skills)).rejects.toThrow("stale");
    expect(await service.status(skills)).toMatchObject({ events: [] });
  });
  test("local recording controls work without a provider connection", async ({ tmp }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.telemetry({ enabled: false });
    expect(await service.status(skills)).toMatchObject({ telemetry: false, connected: false });
    await service.telemetry({ enabled: true });
    expect(await service.status(skills)).toMatchObject({ telemetry: true });
    await expect(service.telemetry({ enabled: "false" })).rejects.toThrow("Choose");
    expect(send).not.toHaveBeenCalled();
  });
  test("changing scope revokes old recommendations and prunes persisted vectors", async ({
    tmp,
  }) => {
    const env = { AIREG_HOME: join(tmp, "home") };
    const send = provider();
    const service = new Discovery(env, send);
    await service.setup(setup, skills);
    await indexed(service);
    const result = (await service.search({ query: "recap notes" }, skills)) as {
      requestId: string;
    };
    await service.setup({ ...setup, registries: ["private"] }, skills);
    await expect(service.handoff({ requestId: result.requestId }, skills)).rejects.toThrow(
      "expired",
    );
    expect(await new Discovery(env, send).status(skills)).toMatchObject({
      indexed: 0,
      registries: ["private"],
    });
  });
  test("a changed provider dimension invalidates the cache so refresh can repair it", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup(setup, skills);
    await indexed(service);
    send.mockResolvedValueOnce(Response.json({ embedding: { values: [1, 0, 0] } }));
    await expect(service.search({ query: "recap notes" }, skills)).rejects.toThrow(
      "dimensions changed",
    );
    expect(await service.status(skills)).toMatchObject({ indexed: 0 });
    await indexed(service);
  });
  test("disconnect cannot keep using a cached key after preferences fail to save", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup(setup, skills);
    await indexed(service);
    const fail = vi
      .spyOn(DiscoveryStore.prototype, "settings")
      .mockRejectedValueOnce(new Error("Synthetic storage failure"));
    try {
      await expect(service.disconnect()).rejects.toThrow("Synthetic storage failure");
      const calls = send.mock.calls.length;
      await expect(service.search({ query: "recap notes" }, skills)).rejects.toThrow(
        "Connect your AI Studio key",
      );
      expect(send.mock.calls.length).toBe(calls);
    } finally {
      fail.mockRestore();
    }
  });
  test("a telemetry failure does not discard a successful search or expose its error", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup(setup, skills);
    await indexed(service);
    const fail = vi
      .spyOn(DiscoveryStore.prototype, "event")
      .mockRejectedValue(new Error("synthetic-private-storage-detail"));
    try {
      expect(await service.search({ query: "recap notes" }, skills)).toMatchObject({
        status: "recommended",
      });
      expect(await service.status(skills)).toMatchObject({
        telemetryWarning: "Local history could not be saved. Check storage permissions.",
      });
    } finally {
      fail.mockRestore();
    }
  });
  test("separate clients share receipts, deduplication and connection revocation", async ({
    tmp,
  }) => {
    const env = { AIREG_HOME: join(tmp, "home") };
    const send = provider();
    const first = new Discovery(env, send);
    await first.setup(setup, skills);
    await indexed(first);
    const result = await first.search({ query: "recap notes" }, skills);
    const second = new Discovery(env, send);
    await second.handoff({ requestId: result.requestId }, skills);
    await first.handoff({ requestId: result.requestId }, skills);
    await second.feedback({ ...result, outcome: "helpful" });
    await expect(first.feedback({ ...result, outcome: "helpful" })).rejects.toThrow(
      "already recorded",
    );
    expect((await first.status(skills)).events.filter((e) => e.type === "handoff")).toHaveLength(1);
    await second.disconnect();
    const calls = send.mock.calls.length;
    await expect(first.handoff({ requestId: result.requestId }, skills)).rejects.toThrow("expired");
    await expect(first.build(skills)).rejects.toThrow("Connect your AI Studio key");
    expect(send.mock.calls.length).toBe(calls);
  });
  test("separate clients cannot mutate settings during an active search", async ({ tmp }) => {
    const env = { AIREG_HOME: join(tmp, "home") };
    const send = provider();
    const first = new Discovery(env, send);
    await first.setup(setup, skills);
    await indexed(first);
    let finish: ((value: Response) => void) | undefined;
    const blocked = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    send.mockImplementationOnce(() => blocked);
    const searching = first.search({ query: "recap notes" }, skills);
    const second = new Discovery(env, send);
    await vi.waitFor(async () => expect((await second.status(skills)).busy).toBe(true));
    try {
      await expect(second.telemetry({ enabled: false })).rejects.toThrow(
        "Another discovery operation",
      );
    } finally {
      finish?.(Response.json({ embedding: { values: [1, 0] } }));
      await searching;
    }
    expect((await second.status(skills)).busy).toBe(false);
  });
});
