import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { followRun } from "#daemon/rpc/client.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ADAPTER, declareUserRegistry, ENDPOINT, NAMESPACE, testClient } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";

const REGISTRY = "acme";
const CLIENT = testClient("onboarding");

async function skill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\nlocal\n`);
}

describe("onboarding through the daemon", () => {
  test("signs in, keeps the registry's name and config, and creates a two-way job", async ({
    home: { dir: home, scope: userScope, aireg },
    daemon,
  }) => {
    vi.stubEnv("AIREG_DEV_REMOTE", join(home, "remote"));

    await skill(join(home, ".claude", "skills"), "local-one");
    await skill(join(home, ".codex", "skills"), "local-two");
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);
    await declareUserRegistry(userScope, REGISTRY);

    const { client } = await daemon.start(CLIENT);
    const { account, created, identity } = await client.request("account.login", {
      registry: REGISTRY,
      defaultNamespace: NAMESPACE,
      config: { namespace: NAMESPACE },
    });
    expect(created).toBe(true);
    expect(account.registry).toBe(REGISTRY);
    expect(account.defaultNamespace).toBe(NAMESPACE);
    expect(identity).toEqual({ name: expect.stringMatching(/^dev-/), account: "Dev registry" });

    const { config: before } = await client.request("state.snapshot", {});
    const createdJob = await client.request("job.create", {
      expectedRevision: before.revision,
      root: userScope,
      scope: "user",
      registry: REGISTRY,
      address: ENDPOINT,
      adapter: "dev",
      config: { namespace: NAMESPACE },
    });
    expect(createdJob.job.id).toBe(`job_skills_${REGISTRY}`);
    expect(createdJob.job.steps.map((step: { kind: string }) => step.kind)).toEqual([
      "pull",
      "publish",
      "prune",
    ]);

    const manifest = await readFile(join(userScope, "manifest.yml"), "utf8");
    expect(manifest).toContain(`namespace: ${NAMESPACE}`);
    expect(manifest).toContain("- claude");
    expect(manifest).toContain("- codex");

    const again = await client
      .request("job.create", {
        expectedRevision: createdJob.config.revision,
        root: userScope,
        scope: "user",
        registry: REGISTRY,
        name: "job_skills_other",
      })
      .catch((error: unknown) => error);
    expect(again).toMatchObject({ code: RpcErrorCode.InvalidParams });

    const { run: started } = await client.request("run.start", {
      jobId: createdJob.job.id,
      mode: "sync",
    });
    await followRun(client, started.id, () => {});
    // The local skills wait for a person, so the run ends in attention, which a retry would repeat.
    const { run: finished } = await client.request("run.get", { runId: started.id });
    expect(finished).toMatchObject({ state: "attention", retryable: false });
    // A refusal carries its code and what to do, which the CLI prints on lines of their own.
    const retried = await client
      .request("run.retry", { runId: started.id })
      .catch((error: unknown) => error);
    expect(retried).toMatchObject({
      message: `Run "${started.id}" cannot be retried, because running it again would end the same way.`,
      data: { code: "conflict", hint: `Run \`aireg job runs ${started.id}\` to see how it ended.` },
    });

    const { runs } = await client.request("run.list", { jobId: createdJob.job.id });
    expect(runs.map((run: { id: string }) => run.id)).toContain(started.id);

    await client.request("account.logout", { accountId: account.id });
    const credentials = JSON.parse(await readFile(join(aireg, "credentials.json"), "utf8"));
    expect(credentials).toEqual({ version: 1, credentials: {} });
  });
});
