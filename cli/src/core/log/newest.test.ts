import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import type { LogRecord } from "./model.ts";
import { isRaw, newestEntries } from "./read.ts";

const read = vi.hoisted(() => ({ bytes: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args);
      read.bytes += count;
      return count;
    },
  };
});

function record(index: number, severity = "info"): string {
  // The body is multi-byte, so a chunk boundary can fall inside a character.
  return JSON.stringify({
    timestamp: `2026-10-08T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    severity_text: severity,
    severity_number: 9,
    body: `entry ${index} é中`,
    attributes: {},
  });
}

let dir: string;

test.beforeEach(async ({ tmp }) => {
  dir = tmp;
  read.bytes = 0;
});

const bodies = (entries: ReturnType<typeof newestEntries>) =>
  entries.map((entry) => (isRaw(entry) ? entry.raw : (entry as LogRecord).body));

describe("newestEntries", () => {
  test("returns the newest entries in order, reading only the end of a large log", async () => {
    const path = join(dir, "daemon.log");
    const lines = Array.from({ length: 20_000 }, (_, index) => record(index));
    await writeFile(path, `${lines.join("\n")}\n`);

    const newest = newestEntries(path, {}, 3);

    expect(bodies(newest)).toEqual(["entry 19997 é中", "entry 19998 é中", "entry 19999 é中"]);
    expect(read.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  test("reads back across chunks until enough entries match, and keeps the first line", async () => {
    const path = join(dir, "daemon.log");
    const lines = Array.from({ length: 5_000 }, (_, index) =>
      record(index, index % 1_000 === 0 ? "error" : "info"),
    );
    // No trailing newline: the last line is still a line.
    await writeFile(path, lines.join("\n"));

    const errors = newestEntries(path, { minLevel: "error" }, 10);

    expect(bodies(errors)).toEqual(
      [0, 1_000, 2_000, 3_000, 4_000].map((index) => `entry ${index} é中`),
    );
  });

  test("returns nothing for no log, or for a limit of none", async () => {
    expect(newestEntries(join(dir, "absent.log"), {}, 5)).toEqual([]);
    const path = join(dir, "daemon.log");
    await writeFile(path, `${record(1)}\n`);
    expect(newestEntries(path, {}, 0)).toEqual([]);
  });
});
