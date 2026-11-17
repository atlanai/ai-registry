import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { UI_DISCOVERY_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { DiscoveryStore, type UsageEvent } from "./store.ts";

const event: UsageEvent = {
  id: "synthetic-id",
  at: "2026-01-01T00:00:00Z",
  type: "search",
  requestId: "synthetic-request",
  skillKey: "",
  durationMs: 5,
  outcome: "none",
};
describe("local discovery history", () => {
  test("bounds retention and pauses future recording without deleting existing history", async ({
    tmp,
  }) => {
    const home = join(tmp, "home");
    await mkdir(home, { mode: 0o700 });
    await writeFile(
      join(home, UI_DISCOVERY_FILE),
      JSON.stringify({
        registries: [],
        telemetry: true,
        events: Array.from({ length: 1000 }, (_, i) => ({ ...event, id: String(i) })),
      }),
    );
    const store = new DiscoveryStore({ AIREG_HOME: home });
    await store.event(event);
    const saved = await store.read();
    expect(saved.events).toHaveLength(1000);
    expect(saved.events[0]?.id).toBe("1");
    await store.settings([], false);
    await store.event({ ...event, id: "not-recorded" });
    expect((await store.read()).events.at(-1)?.id).toBe("synthetic-id");
    await store.clear();
    expect((await store.read()).events).toEqual([]);
  });
  test("refuses symlinked settings instead of overwriting another file", async ({ tmp }) => {
    const home = join(tmp, "home");
    await mkdir(home, { mode: 0o700 });
    const target = join(tmp, "synthetic-target.json");
    await writeFile(target, "untouched");
    await symlink(target, join(home, UI_DISCOVERY_FILE));
    const store = new DiscoveryStore({ AIREG_HOME: home });
    await expect(store.settings([], true)).rejects.toThrow("cannot be read safely");
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
});
