import { afterEach, describe, expect, vi } from "vitest";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { spawnDetached } from "#core/process.ts";
import type { RunResult } from "#engine/install/pipeline.ts";
import { test } from "#test/kit/fixtures.ts";
import { sourceOf, trackRun, trackSearch, trackUpdate } from "./events.ts";
import type { Queued } from "./model.ts";
import { flushTelemetry } from "./queue.ts";

const COLLECTOR = "https://collector.example/t";

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
      trackRun(
        "install",
        {
          before: { artifacts: {} },
          targets: ["codex", "claude-code", "my-own-tool"],
          scope: "user",
          applied: { lock, added: ["lint", "notes"], removed: [] },
        } as unknown as RunResult,
        "add",
      ),
    );
    const shared = {
      event: "install",
      trigger: "add",
      agents: "claude-code,codex,custom",
      global: "1",
    };
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

  test("a restore counts what it linked, though its lockfile came from another machine", async () => {
    const queued = await queuedBy(() =>
      trackRun(
        "install",
        {
          before: lock,
          targets: ["codex"],
          scope: "project",
          applied: { lock, added: [], installed: ["notes"], removed: [] },
        } as unknown as RunResult,
        "install",
      ),
    );
    expect(queued.map((item) => item.event)).toEqual([
      {
        event: "install",
        trigger: "install",
        agents: "codex",
        sourceType: "local",
        kinds: "agent",
      },
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
});
