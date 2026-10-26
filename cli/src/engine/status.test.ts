import { expect, test, vi } from "vitest";
import type { Account } from "#core/config/model.ts";
import { watchStatus } from "./status.ts";
import type { ScopeWork } from "./work.ts";

const close = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./inspect.ts", () => ({
  inspect: async () => ({
    loaded: { roots: { base: "/project" }, manifest: { registries: {} }, targetTable: {} },
    common: { targets: undefined },
    found: { items: [], local: [], undeclared: [], acquired: [{ alias: "shop", close }] },
  }),
}));
vi.mock("./pipeline.ts", () => ({ selectTargets: () => [] }));

test("closes the sources its scan opened, since status is asked for often", async () => {
  const job = { id: "job-1", root: "/project", policy: {} } as unknown as ScopeWork;
  const account = { id: "account-1", registry: "shop" } as Account;

  await watchStatus(job, account, new AbortController().signal);

  expect(close).toHaveBeenCalledTimes(1);
});
