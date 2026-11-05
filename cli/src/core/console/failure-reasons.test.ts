import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { DAEMON_LOG_FILE, logPath } from "#core/log/sink.ts";
import { test } from "#test/kit/fixtures.ts";
import { failureReasons } from "./runs.ts";

const parsed = vi.hoisted(() => ({ count: 0 }));

vi.mock("#core/log/read.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#core/log/read.ts")>();
  return {
    ...actual,
    parseLine: (line: string) => {
      parsed.count += 1;
      return actual.parseLine(line);
    },
  };
});

function line(severity: string, body: string, attributes: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-10-08T00:00:00.000Z",
    severity_text: severity,
    body,
    attributes,
  });
}

let home: string;

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  parsed.count = 0;
});

describe("failureReasons", () => {
  test("reads the newest error for each failed run, parsing only lines that name one", async () => {
    const env = { AIREG_HOME: home };
    const path = logPath(home, DAEMON_LOG_FILE);
    await mkdir(join(path, ".."), { recursive: true });
    const noise = Array.from({ length: 500 }, (_, index) =>
      line("info", `tick ${index}`, { runId: "run_other" }),
    );
    await writeFile(
      path,
      [
        line("error", "first try", { runId: "run_bad" }),
        ...noise,
        line("info", "still going", { runId: "run_bad" }),
        line("error", "scope busy", { runId: "run_bad" }),
        line("error", "not asked about", { runId: "run_fine" }),
      ].join("\n"),
    );

    const reasons = await failureReasons(new Set(["run_bad"]), env);

    expect(reasons).toEqual(new Map([["run_bad", "scope busy"]]));
    expect(parsed.count).toBe(3);
  });

  test("strips terminal escapes a registry put in the message", async () => {
    const env = { AIREG_HOME: home };
    const path = logPath(home, DAEMON_LOG_FILE);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, line("error", "refused \u001b]0;owned\u0007 here", { runId: "run_bad" }));

    const reasons = await failureReasons(new Set(["run_bad"]), env);

    expect(reasons.get("run_bad")).toBe("refused here");
  });

  test("reports nothing when there is no log yet", async () => {
    expect(await failureReasons(new Set(["run_bad"]), { AIREG_HOME: home })).toEqual(new Map());
  });
});
