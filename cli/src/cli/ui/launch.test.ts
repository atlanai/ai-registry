import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openBrowser } from "./launch.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("#core/process.ts", () => ({ spawnDetached: mocks.spawn }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("UI browser launch", () => {
  test("reports an operating-system launch failure", async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const opened = openBrowser("http://127.0.0.1:4000/");
    child.emit("error", new Error("launch denied"));
    expect(await opened).toBe(false);
  });

  test("reports a nonzero launcher exit instead of claiming it opened", async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const opened = openBrowser("http://127.0.0.1:4000/");
    child.emit("exit", 1);
    expect(await opened).toBe(false);
  });

  test("does not wait forever for a browser process that stays open", async () => {
    vi.useFakeTimers();
    mocks.spawn.mockReturnValue(new EventEmitter());
    const opened = openBrowser("http://127.0.0.1:4000/");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await opened).toBe(true);
  });
});
