import { expect, vi } from "vitest";
import type { CommonOptions } from "#engine/options.ts";
import { commandContext } from "#test/kit/command.ts";
import { test } from "#test/kit/fixtures.ts";
import { show } from "./show.ts";

const close = vi.fn(async () => {});

vi.mock("#engine/address/probe.ts", async (original) => ({
  ...(await original<typeof import("#engine/address/probe.ts")>()),
  probe: async () => ({
    alias: "acme",
    location: "/acme",
    revision: undefined,
    layout: undefined,
    catalog: { layouts: [], entries: [], warnings: [] },
    versionOf: () => undefined,
    close,
  }),
}));

const COMMON: CommonOptions = {
  scope: undefined,
  targets: undefined,
  select: undefined,
  yes: false,
  all: false,
  dryRun: false,
  frozen: false,
  force: false,
  copy: false,
};

test("closes the registry it read, once it has the listing", async ({ tmp }) => {
  const options = { argument: tmp, flags: {}, common: COMMON };
  await show.run(options, commandContext([], { cwd: tmp }));
  expect(close).toHaveBeenCalledOnce();
});
