import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { Printer } from "#core/output.ts";
import type { spawnDetached } from "#core/process.ts";
import type { RunResult } from "#engine/pipeline.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  flushTelemetry,
  noticeFirst,
  type Queued,
  sendQueued,
  sourceOf,
  telemetryState,
  trackRun,
  trackSearch,
  trackUpdate,
} from "./telemetry.ts";

const COLLECTOR = "https://collector.example/t";

function recorder(respond: (url: string) => Response | Promise<Response> = () => ok()) {
  const urls: string[] = [];
  const $fetch = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return respond(String(input));
  }) as unknown as typeof fetch;
  return { urls, $fetch };
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

const sent = (urls: string[]) =>
  urls
    .filter((url) => url.startsWith(COLLECTOR))
    .map((url) => Object.fromEntries(new URL(url).searchParams));

const SYNC: Queued = {
  event: { event: "sync", registryCount: "0", changedCount: "0", failedCount: "0" },
};

/** Runs `record`, then returns what the command would hand the detached sender. */
async function queuedBy(record: () => void): Promise<Queued[]> {
  vi.stubEnv("AIREG_TELEMETRY_URL", COLLECTOR);
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("AIREG_DISABLE_TELEMETRY", "");
  let written = "[]";
  const $spawn = (() => ({
    on: () => {},
    stdin: {
      on: () => {},
      end: (data: string, done: () => void) => {
        written = data;
        done();
      },
    },
  })) as unknown as typeof spawnDetached;
  record();
  await flushTelemetry("/bin/aireg", $spawn);
  return JSON.parse(written) as Queued[];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("telemetryState", () => {
  test("is on only for a stamped build, and off once a switch holds a value", () => {
    expect(telemetryState({}, undefined)).toEqual({ on: false, why: "source-build" });
    expect(telemetryState({}, "https://aireg.sh")).toEqual({ on: true, url: "https://aireg.sh/t" });
    for (const name of ["DO_NOT_TRACK", "AIREG_DISABLE_TELEMETRY"]) {
      expect(telemetryState({ [name]: "1" }, "https://aireg.sh")).toMatchObject({ switch: name });
    }
  });
});

describe("sourceOf", () => {
  test("offers only a github.com repository for the public check", () => {
    const github = { sourceType: "github", slug: "acme/skills" };
    const cases = [
      ["https://github.com/acme/skills.git", "git", github],
      ["git@github.com:acme/skills.git", "git", github],
      ["https://user:token@GitHub.com/acme/skills", undefined, github],
      ["https://github.com/acme/skills/tree/main/registry", "git", github],
      ["https://gitlab.com/acme/skills.git", "git", { sourceType: "git" }],
      ["https://github.acme.internal/team/skills.git", "git", { sourceType: "git" }],
      ["/home/me/registry", "local", { sourceType: "local" }],
      ["./registry", undefined, { sourceType: "local" }],
      ["https://skills.example.com", "well-known", { sourceType: "well-known" }],
      ["acme://tenant", "acme-internal", { sourceType: "other" }],
    ] as const;
    for (const [location, adapter, expected] of cases) {
      expect(sourceOf({ location, adapter }), location).toEqual(expected);
    }
  });
});

describe("sendQueued", () => {
  test("sends nothing while telemetry is off", async ({ tmp }) => {
    const { urls, $fetch } = recorder();
    const env = { AIREG_HOME: tmp, AIREG_TELEMETRY_URL: COLLECTOR, DO_NOT_TRACK: "1" };
    await sendQueued(JSON.stringify([SYNC]), env, $fetch);
    expect(urls).toEqual([]);
  });

  test("keeps names only for a repository GitHub confirms is public", async ({ tmp }) => {
    const { urls, $fetch } = recorder((url) => {
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

    const events = sent(urls);
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
      const { urls, $fetch } = recorder();
      const base = { AIREG_HOME: tmp, AIREG_TELEMETRY_URL: COLLECTOR };
      await sendQueued(JSON.stringify([SYNC]), { ...base, ...env }, $fetch);
      agents[label] = sent(urls)[0]?.agent;
    }
    expect(agents).toEqual({
      versioned: "claude-code",
      signal: "cursor",
      lookalike: "other",
      none: undefined,
    });
  });
});

describe("what commands queue", () => {
  const row = (registry: string, name: string, kind: string, version = "1.0.0") =>
    ({ registry, name, kind, version }) as unknown as LockArtifact;
  const lock = {
    registries: {
      open: { location: "https://github.com/acme/skills.git", adapter: "git" },
      mine: { location: "/home/me/registry", adapter: "local" },
    },
    artifacts: { lint: row("open", "lint", "skill"), notes: row("mine", "notes", "agent") },
  } as unknown as Lock;

  test("one install per registry, names offered only for the github.com one", async () => {
    const queued = await queuedBy(() =>
      trackRun("install", {
        before: { artifacts: {} },
        targets: ["codex", "claude-code", "my-own-tool"],
        scope: "user",
        applied: { lock, added: ["lint", "notes"], removed: [] },
      } as unknown as RunResult),
    );
    const shared = { event: "install", agents: "claude-code,codex,custom", global: "1" };
    expect(queued).toEqual([
      {
        event: {
          ...shared,
          sourceType: "github",
          kinds: "skill",
          source: "acme/skills",
          artifacts: "lint",
        },
        github: ["acme/skills"],
      },
      { event: { ...shared, sourceType: "local", kinds: "agent" } },
    ]);
  });

  test("a removal reads the rows it removed, and a dry run queues nothing", async () => {
    const removed = await queuedBy(() =>
      trackRun("remove", {
        before: lock,
        targets: ["codex"],
        scope: "project",
        applied: { lock: { ...lock, artifacts: {} }, added: [], removed: ["notes"] },
      } as unknown as RunResult),
    );
    expect(removed.map((item) => item.event)).toEqual([
      { event: "remove", agents: "codex", sourceType: "local", kinds: "agent" },
    ]);
    const dry = await queuedBy(() =>
      trackRun("install", {
        before: lock,
        targets: [],
        applied: undefined,
      } as unknown as RunResult),
    );
    expect(dry).toEqual([]);
  });

  test("an update counts the rows whose version moved", async () => {
    const lint = row("open", "lint", "skill", "1.1.0");
    const after = { ...lock, artifacts: { ...lock.artifacts, lint } };
    const queued = await queuedBy(() =>
      trackUpdate({
        before: lock,
        scope: "project",
        applied: { lock: after },
      } as unknown as RunResult),
    );
    expect(queued[0]?.event).toEqual({ event: "update", artifactCount: "2", updatedCount: "1" });
  });

  test("a search offers its query only when every registry searched can be checked", async () => {
    const github = { location: "github.com/acme/skills", adapter: undefined };
    const local = { location: "/home/me/registry", adapter: "local" };
    const queued = await queuedBy(() => {
      trackSearch("internal-thing", 1, undefined, [github, local]);
      trackSearch("lint", 2, "skill", [github]);
    });
    expect(queued).toEqual([
      { event: { event: "search", resultCount: "1" } },
      {
        event: { event: "search", resultCount: "2", kind: "skill", query: "lint" },
        github: ["acme/skills"],
      },
    ]);
  });

  test("nothing is handed on while telemetry is off", async () => {
    const $spawn = vi.fn() as unknown as typeof spawnDetached;
    vi.stubEnv("DO_NOT_TRACK", "1");
    trackSearch("lint", 1, undefined, []);
    await flushTelemetry("/bin/aireg", $spawn);
    expect($spawn).not.toHaveBeenCalled();
  });
});

describe("noticeFirst", () => {
  test("shows once per home, and the run that shows it sends nothing", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    vi.stubEnv("AIREG_TELEMETRY_URL", COLLECTOR);
    vi.stubEnv("DO_NOT_TRACK", "");
    vi.stubEnv("AIREG_DISABLE_TELEMETRY", "");
    let err = "";
    const printer = new Printer({
      err: {
        isTTY: false,
        write: (chunk: string) => {
          err += chunk;
        },
      },
    });
    const $spawn = vi.fn(() => ({
      on: () => {},
      stdin: { on: () => {}, end: (_: string, done: () => void) => done() },
    }));
    const run = async () => {
      trackSearch("lint", 1, undefined, []);
      await noticeFirst(printer);
      await flushTelemetry("/bin/aireg", $spawn as unknown as typeof spawnDetached);
    };

    await run();
    expect(err).toContain("notice: aireg sends usage events");
    expect(err).toContain("DO_NOT_TRACK=1");
    expect($spawn).not.toHaveBeenCalled();

    err = "";
    await run();
    expect(err).toBe("");
    expect($spawn).toHaveBeenCalledTimes(1);
  });

  test("says nothing while telemetry is off", async ({ tmp }) => {
    let err = "";
    const printer = new Printer({
      err: {
        isTTY: false,
        write: (chunk: string) => {
          err += chunk;
        },
      },
    });
    await noticeFirst(printer, {
      AIREG_HOME: tmp,
      AIREG_TELEMETRY_URL: COLLECTOR,
      DO_NOT_TRACK: "1",
    });
    expect(err).toBe("");
  });
});
