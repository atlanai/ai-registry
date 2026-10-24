import { afterEach, beforeAll, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { ADAPTER, ENDPOINT } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";
import { inspect } from "./inspect.ts";
import type { Loaded } from "./pipeline.ts";
import type { ScopeWork } from "./work.ts";

const scan = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
vi.mock("./scan.ts", () => ({ scan }));
vi.mock("./pipeline.ts", () => ({ load }));

const TOKEN = "synthetic-env-token";
const account = { id: "account-1", registry: "my--reg" };

function declaring(registries: Record<string, RegistrySource>): Loaded {
  return {
    roots: { scope: "project" },
    manifest: { registries, artifacts: [] },
    lock: { registries: {}, artifacts: {} },
  } as unknown as Loaded;
}

const at = (path: string): RegistrySource => ({
  location: `${ENDPOINT}/${path}`,
  adapter: "dev",
  config: {},
});

let job: ScopeWork;

beforeAll(() => registerBuiltinAdapters());
test.beforeEach(async ({ tmp }) => {
  vi.clearAllMocks();
  vi.stubEnv("AIREG_HOME", tmp);
  vi.stubEnv("AIREG_USER_SCOPE", tmp);
  vi.stubEnv("AIREG_TOKEN_MY__REG", TOKEN);
  await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);
  job = {
    id: "job-1",
    root: tmp,
    scope: "project",
    account: account.id,
    policy: { pull: "on", publish: "off", delete: "off" },
    steps: [],
  };
});
afterEach(() => vi.unstubAllEnvs());

test("refuses a token the job's registry shares with another the project declares", async () => {
  load.mockResolvedValue(declaring({ "my--reg": at("one"), my__reg: at("two") }));

  await expect(inspect(job, account, new AbortController().signal)).rejects.toThrow(
    "AIREG_TOKEN_MY__REG names both my--reg and my__reg",
  );
  expect(scan).not.toHaveBeenCalled();
});
