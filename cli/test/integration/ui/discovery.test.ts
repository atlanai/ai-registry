import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { serve } from "#cli/ui/server.ts";
import { Printer } from "#core/term/printer.ts";
import { SqliteRunStore } from "#daemon/runs/store.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { send } from "#test/kit/ui.ts";

test("authenticated discovery setup, indexing, recommendation and local controls work through HTTP", async ({
  home,
  project,
}) => {
  const folder = join(home.dir, ".claude", "skills", "recap");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: recap\ndescription: Summarize meeting notes into a recap.\n---\nPrivate body excluded from model requests.",
  );
  const provider = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith(":embedContent"))
      return Response.json({ embedding: { values: [1, 0] } });
    const payload = JSON.parse(String(options?.body));
    const choice = Object.hasOwn(payload.questions.skill.criteria, "connected")
      ? "connected"
      : "candidate_0";
    return Response.json({ answers: { skill: { choice, confidence: 0.9 } } });
  });
  vi.stubGlobal("fetch", provider);
  const ui = await serve({
    context: {
      cwd: project,
      argv: [],
      printer: new Printer(),
      host: {
        version: "0.0.0",
        connectAccount: async () => {
          throw new Error("No account expected.");
        },
        openRunStore: () => SqliteRunStore.open(":memory:"),
      },
    } satisfies CommandContext,
    assets: {},
    port: 0,
  });
  const url = new URL(ui.url);
  const auth = {
    authorization: `Bearer ${url.hash.slice(7)}`,
    origin: url.origin,
    "content-type": "application/json",
  };
  const get = async () =>
    JSON.parse((await send(ui.port, "/api/discovery", { headers: auth })).body);
  const post = async (action: string, payload: object = {}) =>
    JSON.parse(
      (
        await send(ui.port, "/api/discovery", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ action, ...payload }),
        })
      ).body,
    );
  try {
    const before = await get();
    expect(before).toMatchObject({ ok: true, data: { connected: false } });
    expect(provider).not.toHaveBeenCalled();
    const registries = before.data.available;
    expect(registries).toHaveLength(1);
    expect(await post("setup", { key: "synthetic-key", registries, consent: false })).toMatchObject(
      { ok: false },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(await post("setup", { key: "synthetic-key", registries, consent: true })).toMatchObject({
      ok: true,
    });
    await post("index");
    await vi.waitFor(async () =>
      expect((await get()).data).toMatchObject({ indexed: 1, job: { running: false } }),
    );
    const result = await post("search", { query: "Prepare a recap" });
    expect(result).toMatchObject({
      ok: true,
      data: { status: "recommended", selected: { name: "recap" } },
    });
    expect(await post("handoff", { requestId: result.data.requestId })).toMatchObject({
      ok: true,
      data: { handoff: { skill: { name: "recap" } } },
    });
    expect((await get()).data.events.map((e: { type: string }) => e.type)).toEqual([
      "search",
      "recommendation",
      "handoff",
    ]);
    expect(JSON.stringify(provider.mock.calls)).not.toContain("Private body excluded");
    const calls = provider.mock.calls.length;
    await post("telemetry", { enabled: false });
    await post("clear");
    expect((await get()).data).toMatchObject({ telemetry: false, events: [] });
    await post("disconnect");
    expect((await get()).data).toMatchObject({ connected: false, indexed: 0, registries: [] });
    expect(provider.mock.calls.length).toBe(calls);
  } finally {
    await ui.close();
    vi.unstubAllGlobals();
  }
});
