import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { follow } from "./tail.ts";

function collect(path: string): { lines: string[]; done: Promise<void>; stop: () => void } {
  const controller = new AbortController();
  const lines: string[] = [];
  const done = (async () => {
    for await (const line of follow({ path, fromByte: 0, signal: controller.signal })) {
      lines.push(line);
    }
  })();
  return { lines, done, stop: () => controller.abort() };
}

describe("follow", () => {
  test("holds a line written in two parts until it ends", async ({ tmp }) => {
    const path = join(tmp, "aireg.log");
    writeFileSync(path, "first\nsec");
    const tail = collect(path);
    await vi.waitFor(() => expect(tail.lines).toEqual(["first"]));
    appendFileSync(path, "ond\n");
    await vi.waitFor(() => expect(tail.lines).toEqual(["first", "second"]));
    tail.stop();
    await tail.done;
  });

  test("yields each appended line once", async ({ tmp }) => {
    const path = join(tmp, "aireg.log");
    writeFileSync(path, "");
    const tail = collect(path);
    for (let index = 0; index < 20; index += 1) appendFileSync(path, `line-${index}\n`);
    await vi.waitFor(() => expect(tail.lines).toHaveLength(20));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tail.lines).toEqual(Array.from({ length: 20 }, (_, index) => `line-${index}`));
    tail.stop();
    await tail.done;
  });

  test("starts over on a new file after a roll", async ({ tmp }) => {
    const path = join(tmp, "aireg.log");
    writeFileSync(path, "old-1\nold-2\n");
    const tail = collect(path);
    await vi.waitFor(() => expect(tail.lines).toEqual(["old-1", "old-2"]));
    writeFileSync(`${path}.next`, "new\n");
    const { renameSync } = await import("node:fs");
    renameSync(`${path}.next`, path);
    await vi.waitFor(() => expect(tail.lines).toEqual(["old-1", "old-2", "new"]));
    tail.stop();
    await tail.done;
  });
});
