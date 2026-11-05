import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import type { Queued } from "./model.ts";
import { sendQueued } from "./send.ts";

const COLLECTOR = "https://collector.example/t";

function recorder(respond: (url: string) => Response | Promise<Response> = () => ok()) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const $fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return respond(String(input));
  }) as unknown as typeof fetch;
  return { requests, $fetch };
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

const sent = (requests: { url: string; init: RequestInit | undefined }[]) =>
  requests
    .filter(({ url }) => url.startsWith(COLLECTOR))
    .map(({ init }) => JSON.parse(String(init?.body)) as Record<string, string>);

const SYNC: Queued = {
  event: { event: "sync", registryCount: "0", changedCount: "0", failedCount: "0" },
};

describe("sendQueued", () => {
  test("posts flat JSON to the collector without event data in its URL or redirects", async ({
    tmp,
  }) => {
    const { requests, $fetch } = recorder();
    const env = { AIREG_HOME: tmp, AIREG_TELEMETRY_URL: COLLECTOR };
    await sendQueued(JSON.stringify([SYNC]), env, $fetch);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: COLLECTOR,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    });
    expect(sent(requests)[0]).toMatchObject({
      ...SYNC.event,
      v: expect.any(String),
      os: process.platform,
      arch: process.arch,
      id: expect.any(String),
    });
    expect(Object.values(sent(requests)[0] ?? {}).every((value) => typeof value === "string")).toBe(
      true,
    );
  });

  test("keeps names only for a repository GitHub confirms is public", async ({ tmp }) => {
    const { requests, $fetch } = recorder((url) => {
      if (url.endsWith("/repos/acme/open")) return ok({ private: false });
      if (url.endsWith("/repos/acme/closed")) return ok({ private: true });
      if (url.endsWith("/repos/acme/gone")) return new Response("", { status: 404 });
      return ok();
    });
    const install = (source: string): Queued => ({
      event: {
        event: "install",
        agents: "codex",
        sourceType: "github",
        kinds: "skill",
        source,
        artifacts: "lint",
      },
      github: [source],
    });
    const search: Queued = {
      event: { event: "search", resultCount: "2", query: "lint" },
      github: ["acme/open", "acme/closed"],
    };
    const queued = [install("acme/open"), install("acme/closed"), install("acme/gone"), search];
    const env = { AIREG_HOME: tmp, AIREG_TELEMETRY_URL: COLLECTOR, CI: "true" };
    await sendQueued(JSON.stringify(queued), env, $fetch);

    const events = sent(requests);
    expect(events).toHaveLength(4);
    expect(events.flatMap((event) => event.source ?? [])).toEqual(["acme/open"]);
    expect(events.filter((event) => "artifacts" in event)).toHaveLength(1);
    expect(events.find((event) => event.event === "search")).not.toHaveProperty("query");
    const id = (await readFile(join(tmp, "telemetry-id"), "utf8")).trim();
    for (const event of events) expect(event).toMatchObject({ id, ci: "1", os: process.platform });
  });

  test("names only an agent aireg knows", async ({ tmp }) => {
    const cases: Record<string, NodeJS.ProcessEnv> = {
      versioned: { AI_AGENT: "claude-code_2-1-316_agent" },
      signal: { CURSOR_AGENT: "1" },
      lookalike: { AI_AGENT: "codexfoo" },
      none: {},
    };
    const agents: Record<string, string | undefined> = {};
    for (const [label, env] of Object.entries(cases)) {
      const { requests, $fetch } = recorder();
      const base = { AIREG_HOME: tmp, AIREG_TELEMETRY_URL: COLLECTOR };
      await sendQueued(JSON.stringify([SYNC]), { ...base, ...env }, $fetch);
      agents[label] = sent(requests)[0]?.agent;
    }
    expect(agents).toEqual({
      versioned: "claude-code",
      signal: "cursor",
      lookalike: "other",
      none: undefined,
    });
  });
});
