import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { Catalogs } from "#cli/ui/catalogs.ts";
import { Events } from "#cli/ui/events.ts";
import type { PageReader } from "#cli/ui/page-state.ts";

const shows: string[] = [];
let inFlight = 0;
let mostInFlight = 0;

vi.mock("#cli/commands/registry/list.ts", () => ({
  list: {
    run: async () => ({
      data: {
        registries: ["a", "b", "c", "d"].map((registry) => ({ registry, address: registry })),
      },
    }),
  },
}));
vi.mock("#cli/commands/registry/show.ts", () => ({
  show: {
    run: async ({ argument }: { argument: string }) => {
      shows.push(argument);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { entries: [] };
    },
  },
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

afterEach(() => {
  shows.length = 0;
  inFlight = 0;
  mostInFlight = 0;
  vi.useRealTimers();
});

describe("aireg ui polling", () => {
  test("a change on disk reads nothing while no page is open", async () => {
    let reads = 0;
    const reader = { read: async () => (reads++, { registries: [] }) } as unknown as PageReader;
    const events = new Events(reader);
    events.changed();
    await settle();
    expect(reads).toBe(0);

    const page = Object.assign(new EventEmitter(), {
      writeHead: () => {},
      write: () => true,
      end: () => {},
    });
    events.attach(page as unknown as ServerResponse, {});
    await settle();
    expect(reads).toBe(1);
    events.close();
  });

  test("catalogs are read at most two at a time and not again while fresh", async () => {
    const catalogs = new Catalogs({} as CommandContext);
    let ended = 0;
    catalogs.onRead = () => ended++;
    await catalogs.read("user");
    await vi.waitFor(() => expect(ended).toBe(4));
    expect(shows).toEqual(["a", "b", "c", "d"]);
    expect(mostInFlight).toBe(2);

    for (let i = 0; i < 20; i++) await catalogs.read("user");
    expect(shows).toHaveLength(4);
  });
});
