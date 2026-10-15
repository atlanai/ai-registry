import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { emptyRegistryConfig, type Job, type Step } from "#core/config/model.ts";
import { roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { registryJobs } from "./jobs.ts";

const step = (kind: string, more: Partial<Step> = {}): Step => ({
  name: kind,
  kind,
  needs: [],
  select: [],
  policy: "on",
  extra: {},
  ...more,
});

const job = (id: string, account: string, steps: Step[]): Job => ({
  id,
  account,
  schedule: { every: 900, enabled: true },
  steps,
});

describe("registryJobs", () => {
  afterEach(() => vi.unstubAllEnvs());

  const setup = async (tmp: string, jobs: Job[]) => {
    const user = join(tmp, "user");
    const project = join(tmp, "app");
    vi.stubEnv("AIREG_USER_SCOPE", user);
    await Promise.all([mkdir(user, { recursive: true }), mkdir(project, { recursive: true })]);
    const config = {
      ...emptyRegistryConfig(),
      accounts: [
        { id: "acc_kit", registry: "kit" },
        { id: "acc_other", registry: "other" },
      ],
      jobs,
    };
    return {
      user: (alias: string) => registryJobs(config, alias, roots("user", tmp)),
      project: (alias: string) => registryJobs(config, alias, roots("project", project)),
    };
  };

  test("takes the sync jobs of its own scope, and no other scope's or registry's", async ({
    tmp,
  }) => {
    const user = join(tmp, "user");
    const project = join(tmp, "app");
    const sync = (root: string) => [step("pull", { root }), step("prune", { root })];
    const { user: fromUser, project: fromProject } = await setup(tmp, [
      job("kit-user", "acc_kit", sync(user)),
      job("kit-app", "acc_kit", sync(project)),
      job("other-user", "acc_other", sync(user)),
    ]);
    expect(fromUser("kit").map((found) => found.id)).toEqual(["kit-user"]);
    expect(fromProject("kit").map((found) => found.id)).toEqual(["kit-app"]);
  });

  test("refuses for a job that publishes your folders into the registry, whatever its account", async ({
    tmp,
  }) => {
    const user = join(tmp, "user");
    const { user: fromUser } = await setup(tmp, [
      job("watch", "acc_other", [
        step("origins", { to: "kit/personal" }),
        step("pull", { root: user }),
      ]),
    ]);
    expect(() => fromUser("kit")).toThrow("Job watch uses registry kit to publish your folders.");
  });

  test("refuses for an adapter's job, which runs in your user scope", async ({ tmp }) => {
    const { user: fromUser, project: fromProject } = await setup(tmp, [
      job("export", "acc_kit", [step("trace-export")]),
    ]);
    expect(() => fromUser("kit")).toThrow("Job export uses registry kit to run trace-export.");
    expect(fromProject("kit")).toEqual([]);
  });
});
