import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { emptyRegistryConfig, type Job, type RegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ADAPTER, ENDPOINT, finished, jobStatus, NAMESPACE, testClient } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";
import { projected } from "#test/kit/target.ts";

const CLIENT = testClient("watch_test");

async function publish(remote: string, body: string): Promise<void> {
  const path = join(remote, NAMESPACE, "skill", "quality-check");
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: quality-check\ndescription: Reviews a change.\n---\n\n${body}\n`,
  );
  await writeFile(
    join(path, "meta.json"),
    `${JSON.stringify({ id: "skill_quality-check", description: "Reviews a change." })}\n`,
  );
}

/** So `account.login` can resolve the alias against the user's own manifest. */
async function declareUserRegistry(scope: string): Promise<void> {
  await mkdir(scope, { recursive: true });
  await writeFile(
    join(scope, "manifest.yml"),
    ["registries:", "  personal:", `    source: ${ENDPOINT}`, "    adapter: dev", ""].join("\n"),
  );
}

describe("job methods", () => {
  test("creates a job, syncs it, and reports drift without applying it", async ({
    tmp,
    home,
    project,
    daemon,
  }) => {
    const remote = join(tmp, "remote");
    await publish(remote, "Read the diff.");
    await declareUserRegistry(home.scope);
    vi.stubEnv("AIREG_DEV_REMOTE", remote);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(CLIENT);
    await client.request("account.login", { registry: "personal" });
    const before = await client.request("state.snapshot", {});
    const created = await client.request("job.create", {
      expectedRevision: before.config.revision,
      root: project,
      scope: "project",
      registry: "personal",
      address: ENDPOINT,
      adapter: "dev",
      config: { namespace: NAMESPACE },
      name: "watch_dev",
      intervalSeconds: 3600,
    });
    expect((created.job as Job).steps.map((step) => step.kind)).toEqual([
      "pull",
      "publish",
      "prune",
    ]);
    const manifest = await readFile(join(project, ".registry", "manifest.yml"), "utf8");
    expect(manifest).toContain(`namespace: ${NAMESPACE}`);
    expect(manifest).toContain("- personal");

    // Not left to the scheduler's next tick: a run it already started is joined.
    const started = await client.request("run.start", {
      jobId: "watch_dev",
      mode: "sync",
    });
    expect((await finished(client, started.run.id)).state).toBe("succeeded");

    const synced = await jobStatus("watch_dev");
    expect(synced.artifacts).toEqual([
      expect.objectContaining({
        name: "quality-check",
        kind: "skill",
        disposition: "synced",
        operation: "none",
        selected: true,
      }),
    ]);

    await publish(remote, "Read the diff, then name the risk.");
    const drifted = await jobStatus("watch_dev");
    expect(drifted.artifacts).toEqual([
      expect.objectContaining({ name: "quality-check", disposition: "pull", operation: "pull" }),
    ]);
    // Reporting drift downloads bytes but must not place them.
    const staged = projected(project, "quality-check");
    expect(await readFile(staged, "utf8")).not.toContain("name the risk");
  });

  test("pauses sync and answers a second pause against the same revision as stale", async ({
    daemon,
  }) => {
    await writeConfig(emptyRegistryConfig(), 0);

    const { client } = await daemon.start(CLIENT);
    const { config } = await client.request("state.snapshot", {});
    const paused = await client.request("settings.patch", {
      expectedRevision: config.revision,
      paused: true,
    });
    expect(paused.config.paused).toBe(true);
    const stale = await client
      .request("settings.patch", { expectedRevision: config.revision, paused: false })
      .catch((error: unknown) => error);
    expect(stale).toMatchObject({
      code: RpcErrorCode.StaleRevision,
      data: { revision: paused.config.revision },
    });
  }, 30_000);

  test("pauses and edits several jobs on one revision, and refuses a job both upserted and removed", async ({
    tmp,
    daemon,
  }) => {
    const seeded: RegistryConfig = {
      ...emptyRegistryConfig(),
      adapters: { dev: ADAPTER },
      accounts: [{ id: "acc_demo", registry: "personal" }],
      jobs: ["watch_one", "watch_two"].map((id) => ({
        id,
        account: "acc_demo",
        schedule: { every: 3600, enabled: true },
        steps: [
          {
            name: "pull",
            kind: "pull" as const,
            needs: [],
            root: join(tmp, id),
            select: [],
            policy: "on" as const,
            extra: {},
          },
        ],
      })),
    };
    await writeConfig(seeded, 0);

    const { client } = await daemon.start(CLIENT);
    const { config } = await client.request("state.snapshot", {});
    const jobs = config.jobs.map((entry) => ({
      ...entry,
      schedule: { ...entry.schedule, enabled: false },
    }));
    const patched = await client.request("settings.patch", {
      expectedRevision: config.revision,
      paused: true,
      jobs: { upsert: jobs },
    });

    expect(patched.config.revision).toBe(config.revision + 1);
    expect(patched.config.paused).toBe(true);
    expect(patched.config.jobs.every(({ schedule }) => !schedule.enabled)).toBe(true);

    const [first] = jobs;
    if (first === undefined) throw new Error("seeded config lost its jobs");
    const contradiction = await client
      .request("settings.patch", {
        expectedRevision: patched.config.revision,
        jobs: { upsert: [first], remove: [first.id] },
      })
      .catch((error: unknown) => error);
    expect(contradiction).toMatchObject({ code: RpcErrorCode.InvalidParams });
  }, 30_000);
});

describe("job.create without login", () => {
  test("adopts a public registry and still writes the job", async ({ tmp, home, daemon }) => {
    const kit = join(tmp, "kit");
    await mkdir(join(kit, "skills", "hello"), { recursive: true });
    await writeFile(join(kit, "skills", "hello", "SKILL.md"), "---\nname: hello\n---\n");
    const userScope = home.scope;
    await mkdir(userScope, { recursive: true });
    await writeFile(
      join(userScope, "manifest.yml"),
      ["registries:", "  kit:", `    source: ${kit}`, "    adapter: local", ""].join("\n"),
    );
    registerBuiltinAdapters();
    await writeConfig(emptyRegistryConfig(), 0);

    const { client } = await daemon.start(testClient("job_adopt"));
    const before = await client.request("state.snapshot", {});
    expect(before.config.accounts).toEqual([]);
    const created = await client.request("job.create", {
      expectedRevision: before.config.revision,
      root: userScope,
      scope: "user",
      registry: "kit",
    });
    expect(created.job.id).toBe("job_skills_kit");
    expect(created.config.accounts).toHaveLength(1);
    expect(created.config.jobs).toHaveLength(1);
  }, 30_000);

  test("declares a named artifact once, and refuses one from another registry", async ({
    tmp,
    home,
    daemon,
  }) => {
    const kit = join(tmp, "kit");
    await mkdir(join(kit, "skills", "hello"), { recursive: true });
    await writeFile(join(kit, "skills", "hello", "SKILL.md"), "---\nname: hello\n---\n");
    const userScope = home.scope;
    await mkdir(userScope, { recursive: true });
    const manifest = join(userScope, "manifest.yml");
    await writeFile(
      manifest,
      [
        "registries:",
        "  kit:",
        `    source: ${kit}`,
        "    adapter: local",
        "artifacts:",
        "  - kit/skill/hello",
        "",
      ].join("\n"),
    );
    registerBuiltinAdapters();
    await writeConfig(emptyRegistryConfig(), 0);
    const { client } = await daemon.start(testClient("job_refs"));
    const create = async (refs: string[]) => {
      const { config } = await client.request("state.snapshot", {});
      return client
        .request("job.create", {
          expectedRevision: config.revision,
          root: userScope,
          scope: "user",
          registry: "kit",
          refs,
          declaredOnly: true,
        })
        .catch((error: unknown) => error);
    };

    expect(await create(["pr-review"])).toMatchObject({ code: RpcErrorCode.InvalidParams });
    expect(await create(["kit/skill/hello@1.0.0", "kit/skill/hello"])).toMatchObject({
      job: { id: "job_skills_kit" },
    });
    expect(await readFile(manifest, "utf8")).toContain("artifacts:\n  - kit/skill/hello\n");
  }, 30_000);

  test("refuses a registry whose adapter requires an account", async ({ project, daemon }) => {
    await mkdir(join(project, ".registry"), { recursive: true });
    await writeFile(
      join(project, ".registry", "manifest.yml"),
      [
        "registries:",
        "  personal:",
        `    source: ${ENDPOINT}`,
        "    adapter: dev",
        "    config:",
        `      namespace: ${NAMESPACE}`,
        "",
      ].join("\n"),
    );
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

    const { client } = await daemon.start(testClient("job_auth"));
    const before = await client.request("state.snapshot", {});
    const failed = await client
      .request("job.create", {
        expectedRevision: before.config.revision,
        root: project,
        scope: "project",
        registry: "personal",
        config: { namespace: NAMESPACE },
      })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: "personal needs a signed-in account for a job to run as.",
      data: {
        code: "unauthorized",
        hint: "Run `aireg auth login personal`. A job never sees AIREG_TOKEN_PERSONAL, since the daemon does not inherit it.",
      },
    });
  });
});

describe("adapter jobs", () => {
  test("is config alone: no manifest, no lease, and nothing to reconcile", async ({
    home,
    daemon,
  }) => {
    const config: RegistryConfig = {
      ...emptyRegistryConfig(),
      adapters: { dev: ADAPTER },
      accounts: [{ id: "acc_demo", registry: "personal" }],
    };
    await writeConfig(config, 0);

    const { client } = await daemon.start(CLIENT);
    const { config: current } = await client.request("state.snapshot", {});
    const created = await client.request("job.create", {
      type: "probe",
      expectedRevision: current.revision,
      account: "acc_demo",
      region: "eu",
      name: "watch_probe",
    });
    // `region` is the adapter's own field, stored without aireg reading it.
    expect(created.job).toEqual({
      id: "watch_probe",
      name: "watch_probe",
      account: "acc_demo",
      schedule: { every: 900, enabled: true },
      steps: [
        {
          name: "probe",
          kind: "probe",
          needs: [],
          select: [],
          policy: "on",
          extra: { region: "eu" },
        },
      ],
    });
    expect(created.config.jobs).toHaveLength(1);
    expect(await readFile(join(home.scope, "manifest.yml"), "utf8").catch(() => "absent")).toBe(
      "absent",
    );

    const resolved = await client
      .request("conflict.resolve", {
        jobId: "watch_probe",
        name: "anything",
        resolution: "theirs",
      })
      .catch((error: unknown) => error);
    expect(resolved).toMatchObject({ code: RpcErrorCode.InvalidParams });

    const patched = await client.request("settings.patch", {
      expectedRevision: created.config.revision,
      jobs: {
        upsert: [{ ...created.job, schedule: { ...created.job.schedule, enabled: false } }],
      },
    });
    expect(patched.config.jobs[0]?.schedule.enabled).toBe(false);
  });
});
