import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { DISCOVERY_SETTINGS_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { type DiscoveryCatalog, discover } from "./actions.ts";
import { DiscoveryIndex } from "./index.ts";
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
const available = ["example", "private"];
const resolve = async (skill: Skill) => skills.find((s) => s.key === skill.key);
const setup = { key: "synthetic-key", consent: true, registries: ["example"], telemetry: true };

describe("discovery user journey", () => {
  test("connects, indexes only approved metadata, routes, prepares a pinned handoff and persists truthful telemetry", async ({
    tmp,
  }) => {
    const env = { AIREG_HOME: join(tmp, "home") };
    const send = provider();
    const service = new Discovery(env, send);
    await service.setup(setup, available);
    await indexed(service);
    const result = (await service.search({ query: "synthetic-private-query" })) as {
      requestId: string;
    };
    expect(await service.handoff({ requestId: result.requestId }, resolve)).toMatchObject({
      handoff: { skill: { key: "example/recap", digest: "digest-one", version: "1" } },
    });
    await service.feedback({ ...result, outcome: "helpful" });
    await service.handoff({ requestId: result.requestId }, resolve);
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
    await restarted.search({ query: "recap notes" });
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
    await expect(service.setup({ ...setup, consent: false }, available)).rejects.toThrow("approve");
    await expect(service.setup({ ...setup, registries: ["invented"] }, available)).rejects.toThrow(
      "Choose",
    );
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(new Response("synthetic-error", { status: 403 }));
    await expect(service.setup(setup, available)).rejects.toThrow("403");
    expect(await service.status(skills)).toMatchObject({ connected: false });
  });
  test("searches the saved snapshot, rejects changed handoffs, and reuses unchanged embeddings", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup(setup, available);
    await indexed(service);
    const calls = send.mock.calls.length;
    await indexed(service);
    expect(send.mock.calls.length).toBe(calls);
    const result = (await service.search({ query: "recap notes" })) as {
      requestId: string;
    };
    const changed = skills.map((s) => ({ ...s, digest: "changed" }));
    await expect(service.search({ query: "recap notes" })).resolves.toMatchObject({
      status: "recommended",
    });
    await expect(
      service.handoff(result, async (skill) => changed.find((s) => s.key === skill.key)),
    ).rejects.toThrow("stale");
  });
  test("supports abstention and paused telemetry without fabricating a handoff", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup({ ...setup, telemetry: false }, available);
    await indexed(service);
    send
      .mockResolvedValueOnce(Response.json({ embedding: { values: [1, 0] } }))
      .mockResolvedValueOnce(
        Response.json({ answers: { skill: { choice: "none", confidence: 0.8 } } }),
      );
    const result = (await service.search({ query: "unrelated task" })) as {
      requestId: string;
    };
    expect(result).toMatchObject({ status: "none", selected: null });
    await expect(service.handoff({ requestId: result.requestId }, resolve)).rejects.toThrow(
      "stale",
    );
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
    await service.setup(setup, available);
    await indexed(service);
    const result = (await service.search({ query: "recap notes" })) as {
      requestId: string;
    };
    await service.setup({ ...setup, registries: ["private"] }, available);
    await expect(service.handoff({ requestId: result.requestId }, resolve)).rejects.toThrow(
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
    await service.setup(setup, available);
    await indexed(service);
    send.mockResolvedValueOnce(Response.json({ embedding: { values: [1, 0, 0] } }));
    await expect(service.search({ query: "recap notes" })).rejects.toThrow("dimensions changed");
    expect(await service.status(skills)).toMatchObject({ indexed: 0 });
    await indexed(service);
  });
  test("disconnect cannot keep using a cached key after preferences fail to save", async ({
    tmp,
  }) => {
    const send = provider();
    const service = new Discovery({ AIREG_HOME: join(tmp, "home") }, send);
    await service.setup(setup, available);
    await indexed(service);
    const fail = vi
      .spyOn(DiscoveryStore.prototype, "settings")
      .mockRejectedValueOnce(new Error("Synthetic storage failure"));
    try {
      await expect(service.disconnect()).rejects.toThrow("Synthetic storage failure");
      const calls = send.mock.calls.length;
      await expect(service.search({ query: "recap notes" })).rejects.toThrow(
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
    await service.setup(setup, available);
    await indexed(service);
    const fail = vi
      .spyOn(DiscoveryStore.prototype, "event")
      .mockRejectedValue(new Error("synthetic-private-storage-detail"));
    try {
      expect(await service.search({ query: "recap notes" })).toMatchObject({
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
    await first.setup(setup, available);
    await indexed(first);
    const result = await first.search({ query: "recap notes" });
    const second = new Discovery(env, send);
    await second.handoff({ requestId: result.requestId }, resolve);
    await first.handoff({ requestId: result.requestId }, resolve);
    await second.feedback({ ...result, outcome: "helpful" });
    await expect(first.feedback({ ...result, outcome: "helpful" })).rejects.toThrow(
      "already recorded",
    );
    expect((await first.status(skills)).events.filter((e) => e.type === "handoff")).toHaveLength(1);
    await second.disconnect();
    const calls = send.mock.calls.length;
    await expect(first.handoff({ requestId: result.requestId }, resolve)).rejects.toThrow(
      "expired",
    );
    await expect(first.build(skills)).rejects.toThrow("Connect your AI Studio key");
    expect(send.mock.calls.length).toBe(calls);
  });
  test("separate clients cannot mutate settings during an active search", async ({ tmp }) => {
    const env = { AIREG_HOME: join(tmp, "home") };
    const send = provider();
    const first = new Discovery(env, send);
    await first.setup(setup, available);
    await indexed(first);
    let finish: ((value: Response) => void) | undefined;
    const blocked = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    send.mockImplementationOnce(() => blocked);
    const searching = first.search({ query: "recap notes" });
    const second = new Discovery(env, send);
    await vi.waitFor(async () => expect((await second.status(skills)).busy).toBe(true));
    try {
      await expect(second.telemetry({ enabled: false })).rejects.toThrow(
        "Another discovery operation",
      );
    } finally {
      await finish?.(Response.json({ embedding: { values: [1, 0] } }));
      await searching;
    }
    expect((await second.status(skills)).busy).toBe(false);
  });
});

test("fresh clients search and read usage without loading any source, and handoff resolves only the selected skill", async ({
  tmp,
}) => {
  const env = { AIREG_HOME: tmp };
  const send = provider();
  const service = new Discovery(env, send);
  await service.setup(setup, available);
  await service.build(skills);
  const catalog: DiscoveryCatalog = {
    available: vi.fn(async () => {
      throw new Error("Catalog must not load");
    }),
    list: vi.fn(async () => {
      throw new Error("Catalog must not load");
    }),
    resolve: vi.fn(resolve),
  };
  const result = await discover(
    new Discovery(env, send),
    "search",
    { query: "recap notes" },
    catalog,
  );
  expect(result).toMatchObject({ status: "recommended" });
  const requestId = "requestId" in result ? result.requestId : "";
  await discover(new Discovery(env, send), "handoff", { requestId }, catalog);
  const calls = send.mock.calls.length;
  expect(await discover(new Discovery(env, send), "usage", {}, catalog)).toMatchObject({
    indexed: 1,
    indexReady: true,
  });
  expect(send.mock.calls.length).toBe(calls);
  expect(catalog.list).not.toHaveBeenCalled();
  expect(catalog.available).not.toHaveBeenCalled();
  expect(catalog.resolve).toHaveBeenCalledExactlyOnceWith(skills[0]);
});

test("partial checkpoints cannot be searched and a resumed refresh reuses their embeddings", async ({
  tmp,
}) => {
  const env = { AIREG_HOME: tmp };
  const send = provider();
  const service = new Discovery(env, send);
  await service.setup(setup, available);
  await service.build(skills);
  const snapshot = await new DiscoveryIndex(env).read();
  await new DiscoveryIndex(env).save(snapshot.entries.values(), false);
  const restarted = new Discovery(env, send);
  const before = send.mock.calls.length;
  await expect(restarted.search({ query: "recap notes" })).rejects.toThrow("incomplete");
  expect((await restarted.status()).indexReady).toBe(false);
  await restarted.build(skills);
  expect(send.mock.calls.length).toBe(before);
  expect((await restarted.status()).indexReady).toBe(true);
});

test("provider failure keeps a non-searchable checkpoint and retry embeds only unfinished skills", async ({
  tmp,
}) => {
  const send = provider();
  const service = new Discovery({ AIREG_HOME: tmp }, send);
  const both = skills.map((skill) => ({ ...skill, registry: "example" }));
  await service.setup(setup, available);
  send
    .mockResolvedValueOnce(Response.json({ embedding: { values: [1, 0] } }))
    .mockResolvedValueOnce(new Response("synthetic failure", { status: 429 }));
  await expect(service.build(both)).rejects.toThrow("429");
  expect(await service.status()).toMatchObject({ indexed: 1, indexReady: false });
  const calls = send.mock.calls.length;
  await expect(service.search({ query: "recap notes" })).rejects.toThrow("incomplete");
  const retry = new Discovery({ AIREG_HOME: tmp }, send);
  await retry.build(both);
  expect(send.mock.calls.length).toBe(calls + 1);
  expect(await retry.status()).toMatchObject({ indexed: 2, indexReady: true });
});

test("a checkpoint write failure releases indexing state for retry", async ({ tmp }) => {
  const service = new Discovery({ AIREG_HOME: tmp }, provider());
  await service.setup(setup, available);
  const failure = vi
    .spyOn(DiscoveryIndex.prototype, "save")
    .mockRejectedValueOnce(new Error("synthetic storage failure"));
  try {
    await expect(service.build(skills)).rejects.toThrow("Discovery could not complete");
  } finally {
    failure.mockRestore();
  }
  expect(await service.status()).toMatchObject({
    busy: false,
    job: { running: false },
    indexReady: false,
  });
  await service.build(skills);
  expect((await service.status()).indexReady).toBe(true);
});

test("refresh removes the final deleted skill rather than leaving an old recommendation searchable", async ({
  tmp,
}) => {
  const service = new Discovery({ AIREG_HOME: tmp }, provider());
  await service.setup(setup, available);
  await service.build(skills);
  const result = await service.search({ query: "recap notes" });
  await service.build([]);
  expect(await service.status()).toMatchObject({ indexed: 0, indexReady: false });
  await expect(service.search({ query: "recap notes" })).rejects.toThrow("Build or refresh");
  const check = vi.fn(resolve);
  await expect(service.handoff({ requestId: result.requestId }, check)).rejects.toThrow("stale");
  expect(check).not.toHaveBeenCalled();
});
