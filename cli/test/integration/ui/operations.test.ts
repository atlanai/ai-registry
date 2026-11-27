import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, test } from "vitest";
import { Operations, UiError } from "#cli/ui/operations.ts";
import type { KeptArtifact, PageReader } from "#cli/ui/page-state.ts";
import type { UiEvent } from "#cli/ui/protocol.ts";
import type { Command, Running, Stream } from "#core/child/commands.ts";
import { processAlive } from "#core/process.ts";
import { tempDir } from "#test/kit/temp.ts";

const GRACE_MS = 300;

const reader = {
  read: async () => ({ root: process.cwd(), console: { scope: "user" }, artifacts: [] }),
} as unknown as PageReader;

/** A child that prints its pid and, if told to, shrugs off SIGINT. */
const STUBBORN = `
process.on("SIGINT", () => {});
console.log(process.pid);
setInterval(() => {}, 1000);
`;
const POLITE = `
console.log(process.pid);
setInterval(() => {}, 1000);
`;

interface Spawned {
  pids: Promise<number>[];
  signals: NodeJS.Signals[];
}

/** Runs `script` for every command; records what each child was sent. */
function nodeChildren(script: string, spawned: Spawned) {
  return (_command: Command, _root: string, onLine: (line: string, stream: Stream) => void) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let pid: (value: number) => void = () => {};
    spawned.pids.push(new Promise((resolve) => (pid = resolve)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      pid(Number(line));
      onLine(line, "stdout");
    });
    const done = new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? -1)),
    );
    const running: Running = {
      done,
      cancel: (signal = "SIGINT") => {
        spawned.signals.push(signal);
        child.kill(signal);
      },
    };
    return running;
  };
}

/** Prints each dry run in turn as `aireg add --dry-run --json` would, and runs nothing else. */
function dryRuns(...installed: string[][]) {
  const launched: string[][] = [];
  const start = (
    command: Command,
    _root: string,
    onLine: (line: string, stream: Stream) => void,
  ) => {
    if (command.argv.includes("--dry-run")) {
      const data = { registry: "acme", installed: installed.shift() ?? [], untrusted: [] };
      onLine(JSON.stringify({ ok: true, data }), "stdout");
    } else launched.push(command.argv);
    return { done: Promise.resolve(0), cancel: () => {} } satisfies Running;
  };
  return { start, launched };
}

describe("the UI's children", () => {
  test.skipIf(process.platform === "win32")(
    "closing interrupts a run, then kills it once the grace is up, and waits for it",
    async () => {
      const spawned: Spawned = { pids: [], signals: [] };
      const operations = new Operations(
        reader,
        () => {},
        () => {},
        {
          start: nodeChildren(STUBBORN, spawned),
          graceMs: GRACE_MS,
        },
      );
      await operations.sync();
      const pid = await spawned.pids[0];
      await operations.close();
      expect(spawned.signals).toEqual(["SIGINT", "SIGKILL"]);
      await expect(operations.sync()).rejects.toThrow("stopping");
      expect(processAlive(pid ?? 0)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "closing stops a read the page is waiting on, not only runs",
    async () => {
      const spawned: Spawned = { pids: [], signals: [] };
      const operations = new Operations(
        reader,
        () => {},
        () => {},
        {
          start: nodeChildren(POLITE, spawned),
          graceMs: GRACE_MS,
        },
      );
      const doctor = operations.doctor().catch((error: unknown) => error);
      await expect.poll(() => spawned.pids.length).toBe(1);
      const pid = await spawned.pids[0];
      await operations.close();
      expect(spawned.signals).toEqual(["SIGINT"]);
      expect(processAlive(pid ?? 0)).toBe(false);
      expect(await doctor).toBeInstanceOf(UiError);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a cancelled run gets SIGINT, and SIGKILL only if it outlasts the grace",
    async () => {
      const spawned: Spawned = { pids: [], signals: [] };
      const events: UiEvent[] = [];
      const operations = new Operations(
        reader,
        (event) => events.push(event),
        () => {},
        {
          start: nodeChildren(STUBBORN, spawned),
          graceMs: GRACE_MS,
        },
      );
      const { runId } = await operations.sync();
      await spawned.pids[0];
      expect(operations.cancel(runId)).toEqual({ cancelled: true });
      expect(spawned.signals).toEqual(["SIGINT"]);
      await expect
        .poll(() => events.some((e) => e.type === "run.event" && e.eventType === "run.finished"))
        .toBe(true);
      expect(spawned.signals).toEqual(["SIGINT", "SIGKILL"]);
      expect(events.filter((e) => e.type === "run.event").map((e) => e.seq)).toEqual(
        events.filter((e) => e.type === "run.event").map((_, at) => at + 1),
      );
    },
  );
});

describe("applying a plan", () => {
  test("installs when a fresh dry run shows what the preview did", async () => {
    const { start, launched } = dryRuns(["pr-review"], ["pr-review"]);
    const operations = new Operations(
      reader,
      () => {},
      () => {},
      { start },
    );
    const plan = await operations.plan("acme", ["pr-review"]);
    await operations.apply(plan.planId, []);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain("--select=pr-review");
  });

  test("refuses when the registry changed since the preview", async () => {
    const { start, launched } = dryRuns(["pr-review"], ["pr-review", "reviewer"]);
    const operations = new Operations(
      reader,
      () => {},
      () => {},
      { start },
    );
    const plan = await operations.plan("acme", []);
    const refused = await operations.apply(plan.planId, []).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UiError);
    expect((refused as UiError).message).toContain("The registry changed since the preview");
    expect((refused as UiError).hint).toBe("Preview again.");
    expect(launched).toEqual([]);
  });
});

describe("reading an installed file", () => {
  test.each([
    ["semantic_model.yaml", "semantic_model:\n  name: retail\n"],
    ["semantic_model.json", '{"name":"retail"}\n'],
  ])("reads an installed semantic model's %s without falling back to show", async (entry, body) => {
    const dir = await tempDir("ui-semantic-model-");
    try {
      await writeFile(join(dir, entry), body, "utf8");
      const artifact: KeptArtifact = {
        key: "acme/analytics/semantic_model/retail",
        name: "retail",
        namespace: "analytics",
        registry: "acme",
        kind: "semantic_model",
        version: "0.1.0",
        installedVersion: "0.1.0",
        description: "Retail metrics.",
        state: "ok",
        detail: "",
        digest: "sha256:abc",
        diskDigest: "sha256:abc",
        path: "~/.registry/artifacts/acme/analytics/semantic_models/retail",
        links: [],
        harnesses: [],
        listed: true,
        carriedBy: undefined,
        copy: dir,
        installedKey: "acme/analytics/semantic_model/retail",
        local: false,
      };
      const modelReader = {
        read: async () => ({
          root: dir,
          console: { scope: "project" },
          artifacts: [artifact],
        }),
      } as unknown as PageReader;
      const { start, launched } = dryRuns();
      const operations = new Operations(
        modelReader,
        () => {},
        () => {},
        { start },
      );

      await expect(operations.file(artifact.key)).resolves.toEqual({
        key: artifact.key,
        text: body,
        from: "installed",
      });
      expect(launched).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
