import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { executableFile } from "#core/product.ts";
import type { ResolvedRelease } from "#self/release.ts";
import {
  applyDaemonCliUpdate,
  applyDaemonFollowInstalled,
  DaemonMinUpdate,
  MIN_UPDATE_INTERVAL_MS,
} from "./cli-update.ts";

const home = { AIREG_HOME: "/tmp/aireg-home" };
const release: ResolvedRelease = {
  version: "0.2.0",
  minimumVersion: "0.1.0",
  plan: {
    kind: "manifest",
    url: "https://releases.example.com/aireg/artifacts/v0.2.0/aireg-darwin-arm64",
    name: "aireg-darwin-arm64",
    sha256: "0".repeat(64),
    size: 1,
  },
};

function hooks(over: Partial<Parameters<typeof applyDaemonCliUpdate>[0]> = {}) {
  return {
    busy: () => false,
    skip: () => false,
    current: "0.0.9",
    env: home,
    close: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    probe: vi.fn(async () => release),
    install: vi.fn(async () => {}),
    ...over,
  };
}

describe("applyDaemonCliUpdate", () => {
  test("skips when opted out or a run is in flight", async () => {
    const idle = hooks({ skip: () => true });
    expect(await applyDaemonCliUpdate(idle)).toBe("skip");
    expect(idle.probe).not.toHaveBeenCalled();

    const busy = hooks({ busy: () => true });
    expect(await applyDaemonCliUpdate(busy)).toBe("skip");
    expect(busy.probe).not.toHaveBeenCalled();
  });

  test("skips a failed probe and a daemon already on the channel head", async () => {
    const failed = hooks({ probe: async () => undefined });
    expect(await applyDaemonCliUpdate(failed)).toBe("skip");
    expect(failed.install).not.toHaveBeenCalled();

    const current = hooks({ current: "0.2.0" });
    expect(await applyDaemonCliUpdate(current)).toBe("skip");
    expect(current.install).not.toHaveBeenCalled();
  });

  test("updates to a newer head even when already at the floor", async () => {
    const next = hooks({ current: "0.1.0", present: async () => false });
    expect(await applyDaemonCliUpdate(next)).toBe("replace");
    expect(next.install).toHaveBeenCalledOnce();
  });

  test("holds a rollback: a head already on disk is not fetched again, unless below the floor", async () => {
    const rolledBack = hooks({ current: "0.1.0", present: async () => true });
    expect(await applyDaemonCliUpdate(rolledBack)).toBe("skip");
    expect(rolledBack.install).not.toHaveBeenCalled();

    const belowFloor = hooks({ current: "0.0.9", present: async () => true });
    expect(await applyDaemonCliUpdate(belowFloor)).toBe("replace");
    expect(belowFloor.install).toHaveBeenCalledOnce();
  });

  test("installs latest, closes this process, and starts the new binary", async () => {
    const next = hooks();
    expect(await applyDaemonCliUpdate(next)).toBe("replace");
    expect(next.install).toHaveBeenCalledWith(release, home, expect.any(Function));
    expect(next.close).toHaveBeenCalledOnce();
    expect(next.start).toHaveBeenCalledWith(
      join("/tmp/aireg-home/cli/0.2.0", executableFile()),
      "0.2.0",
    );
  });

  test("leaves the replacement to a supervisor instead of spawning one", async () => {
    const restart = vi.fn(async () => {});
    const next = hooks({ restart });
    expect(await applyDaemonCliUpdate(next)).toBe("replace");
    expect(next.install).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(next.close).not.toHaveBeenCalled();
    expect(next.start).not.toHaveBeenCalled();
  });

  test("marks the process failed if the replacement daemon does not start", async () => {
    const previous = process.exitCode;
    const next = hooks({
      start: vi.fn(async () => {
        throw new Error("The aireg daemon did not start within 5 seconds");
      }),
    });
    try {
      await expect(applyDaemonCliUpdate(next)).rejects.toThrow(/did not start/);
      expect(next.close).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });
});

function follow(over: Partial<Parameters<typeof applyDaemonFollowInstalled>[0]> = {}) {
  return {
    busy: () => false,
    skip: () => false,
    current: "0.1.0",
    env: home,
    close: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    installed: vi.fn(async (): Promise<string | undefined> => "0.2.0"),
    ...over,
  };
}

describe("applyDaemonFollowInstalled", () => {
  test("replaces itself with a newer installed version, with no download", async () => {
    const next = follow();
    expect(await applyDaemonFollowInstalled(next)).toBe("replace");
    expect(next.close).toHaveBeenCalledOnce();
    expect(next.start).toHaveBeenCalledWith(
      join("/tmp/aireg-home/cli/0.2.0", executableFile()),
      "0.2.0",
    );
  });

  test("never downgrades, and skips when nothing runnable is installed", async () => {
    for (const installed of ["0.1.0", "0.0.9", undefined]) {
      const next = follow({ installed: async () => installed });
      expect(await applyDaemonFollowInstalled(next)).toBe("skip");
      expect(next.start).not.toHaveBeenCalled();
    }
  });

  test("waits out a run in flight, and a replace already under way", async () => {
    const next = follow({ busy: () => true });
    expect(await applyDaemonFollowInstalled(next)).toBe("skip");
    expect(next.installed).not.toHaveBeenCalled();
    expect(next.close).not.toHaveBeenCalled();
  });

  test("leaves the replacement to a supervisor", async () => {
    const restart = vi.fn(async () => {});
    const next = follow({ restart });
    expect(await applyDaemonFollowInstalled(next)).toBe("replace");
    expect(restart).toHaveBeenCalledOnce();
    expect(next.start).not.toHaveBeenCalled();
  });
});

describe("DaemonMinUpdate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("checks immediately and every 15 minutes until a replace", async () => {
    vi.useFakeTimers();
    const apply = vi.fn(
      async (): Promise<"skip" | "replace"> => (apply.mock.calls.length >= 2 ? "replace" : "skip"),
    );
    const loop = new DaemonMinUpdate(apply, MIN_UPDATE_INTERVAL_MS);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN_UPDATE_INTERVAL_MS);
    expect(apply).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MIN_UPDATE_INTERVAL_MS);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  test("does not overlap ticks and retries after a thrown apply", async () => {
    vi.useFakeTimers();
    let inflight = 0;
    let overlap = 0;
    let unblock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const apply = vi.fn(async (): Promise<"skip" | "replace"> => {
      inflight += 1;
      overlap = Math.max(overlap, inflight);
      if (apply.mock.calls.length === 1) {
        await held;
        inflight -= 1;
        throw new Error("install failed");
      }
      inflight -= 1;
      return "skip";
    });
    const loop = new DaemonMinUpdate(apply, 1_000);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(apply).toHaveBeenCalledTimes(1);
    unblock();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(overlap).toBe(1);
    expect(apply).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});
