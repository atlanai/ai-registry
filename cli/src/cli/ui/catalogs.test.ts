import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";

const shown = vi.hoisted(() => ({ calls: 0, next: [] as (() => Promise<unknown>)[] }));

vi.mock("#cli/commands/registry/list.ts", () => ({
  list: {
    run: async () => ({
      data: {
        registries: [
          { registry: "slow", address: "/r/slow" },
          { registry: "fast", address: "/r/fast" },
        ],
      },
    }),
  },
}));
vi.mock("#cli/commands/registry/show.ts", () => ({
  show: {
    run: (options: { argument: string }) => {
      shown.calls += 1;
      const step = shown.next.shift();
      if (step !== undefined) return step();
      return Promise.resolve({
        entries: [{ name: `${options.argument}-skill`, kind: "skill", path: "p" }],
      });
    },
  },
}));

const { Catalogs } = await import("./catalogs.ts");
const context = {} as CommandContext;

beforeEach(() => {
  shown.calls = 0;
  shown.next = [];
});

describe("reading each registry's catalog", () => {
  test("says why a registry did not list its artifacts, and keeps the others", async () => {
    shown.next = [() => Promise.reject(new Error("the registry is down"))];
    const read = await new Catalogs(context).read("user");
    expect(read.catalogs.map((c) => [c.name, c.entries.length, c.error])).toEqual([
      ["slow", 0, "the registry is down"],
      ["fast", 1, undefined],
    ]);
  });

  test("draws without a registry that is slow to answer, and adds it once it does", async () => {
    let answer: (value: unknown) => void = () => {};
    shown.next = [() => new Promise((resolve) => (answer = resolve))];
    const catalogs = new Catalogs(context);
    const first = await catalogs.read("user");
    expect(first.catalogs.map((c) => [c.name, c.loading])).toEqual([
      ["slow", true],
      ["fast", false],
    ]);
    answer({ entries: [{ name: "late", kind: "skill", path: "l" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await catalogs.read("user");
    expect(second.catalogs[0]).toMatchObject({
      name: "slow",
      loading: false,
      entries: [{ name: "late" }],
    });
  }, 10_000);

  test("reads a catalog once while it is fresh, not on every page read", async () => {
    const catalogs = new Catalogs(context);
    await catalogs.read("user");
    await catalogs.read("user");
    expect(shown.calls).toBe(2);
  });
});
