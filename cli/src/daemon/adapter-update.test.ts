import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executableFile } from "#core/product.ts";
import { applyDaemonAdapterUpdate } from "./adapter-update.ts";

describe("applyDaemonAdapterUpdate", () => {
  function hooks(updated: readonly string[], busy = false) {
    return {
      busy: () => busy,
      skip: () => false,
      current: "0.2.0",
      env: { AIREG_HOME: "/tmp/aireg-home" },
      close: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      update: vi.fn(async () => updated),
    };
  }

  it("restarts on the same version after an adapter update, so it loads", async () => {
    const next = hooks(["acme 1.1.0"]);
    expect(await applyDaemonAdapterUpdate(next)).toBe("replace");
    expect(next.start).toHaveBeenCalledWith(
      join("/tmp/aireg-home/cli/0.2.0", executableFile()),
      "0.2.0",
    );
  });

  it("stays up when nothing changed or a run is in flight", async () => {
    const idle = hooks([]);
    expect(await applyDaemonAdapterUpdate(idle)).toBe("skip");
    expect(idle.close).not.toHaveBeenCalled();

    const busy = hooks(["acme 1.1.0"], true);
    expect(await applyDaemonAdapterUpdate(busy)).toBe("skip");
    expect(busy.update).not.toHaveBeenCalled();
  });
});
