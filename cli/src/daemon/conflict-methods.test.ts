import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { ITEM_EVENT } from "#core/run/model.ts";
import type { RpcClient } from "#daemon/rpc/client.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import {
  ADAPTER,
  ENDPOINT,
  finished,
  jobStatus,
  NAMESPACE,
  terminal,
  testClient,
  wait,
} from "#test/kit/daemon.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { projected } from "#test/kit/harness.ts";
import { resolvable } from "./conflict-methods.ts";

const WATCH = "watch_dev";
const SKILL = "quality-check";
const CLIENT = testClient("conflict_test");

const BASE_BODY = "Establish the timeline first.";
const UPSTREAM_BODY = "Name the risk before the fix.";
const LOCAL_BODY = "Stop at the first real defect.";

function upstreamDir(remote: string): string {
  return join(remote, NAMESPACE, "skill", SKILL);
}

function stagedDir(project: string): string {
  return dirname(projected(project, SKILL));
}

async function publishUpstream(remote: string, body: string): Promise<void> {
  const path = upstreamDir(remote);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: Reviews a change.\n---\n\n${body}\n`,
  );
  await writeFile(
    join(path, "meta.json"),
    `${JSON.stringify({ id: `skill_${SKILL}`, description: "Reviews a change." })}\n`,
  );
}

async function editLocally(project: string, body: string): Promise<void> {
  await writeFile(
    join(stagedDir(project), "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: Reviews a change.\n---\n\n${body}\n`,
  );
}

interface Environment {
  project: string;
  remote: string;
  client: RpcClient;
}

/** A job whose one artifact is installed and settled, ready to be pulled apart. */
const test = base.extend("setup", async ({ tmp, home, project, daemon }): Promise<Environment> => {
  const remote = join(tmp, "remote");
  await publishUpstream(remote, BASE_BODY);
  vi.stubEnv("AIREG_DEV_REMOTE", remote);
  await mkdir(home.scope, { recursive: true });
  await writeFile(
    join(home.scope, "manifest.yml"),
    ["registries:", "  personal:", `    source: ${ENDPOINT}`, "    adapter: dev", ""].join("\n"),
  );
  await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);

  const { client } = await daemon.start(CLIENT);
  await client.request("account.login", { registry: "personal" });
  const before = await client.request("state.snapshot", {});
  await client.request("job.create", {
    expectedRevision: before.config.revision,
    root: project,
    scope: "project",
    registry: "personal",
    address: ENDPOINT,
    adapter: "dev",
    config: { namespace: NAMESPACE },
    name: WATCH,
    intervalSeconds: 3600,
  });
  // The scheduler syncs a new job on its own; everything after waits for that.
  await wait("Scheduled run", async () => {
    const { runs } = await client.request("run.list", { jobId: WATCH });
    return runs.length > 0 && runs.every(terminal) ? runs[0] : undefined;
  });
  return { project, remote, client };
});

/** Both sides move, which is the only thing that never reconciles itself. */
async function diverge(project: string, remote: string): Promise<void> {
  await publishUpstream(remote, UPSTREAM_BODY);
  await editLocally(project, LOCAL_BODY);
}

describe("conflict methods", () => {
  test("takes the registry's copy for `theirs` and settles the artifact", async ({ setup }) => {
    await diverge(setup.project, setup.remote);
    const { run } = await setup.client.request("conflict.resolve", {
      jobId: WATCH,
      name: SKILL,
      resolution: "theirs",
    });
    expect((await finished(setup.client, run.id)).state).toBe("succeeded");

    const { events } = await setup.client.request("run.events", { runId: run.id });
    expect(events.find((event) => event.eventType === ITEM_EVENT)).toMatchObject({
      artifact: SKILL,
      kind: "skill",
      disposition: "conflict",
      operation: "pull",
      outcome: "changed",
    });

    const staged = await readFile(join(stagedDir(setup.project), "SKILL.md"), "utf8");
    expect(staged).toContain(UPSTREAM_BODY);
    const settled = await jobStatus(WATCH);
    expect(settled.artifacts).toEqual([
      expect.objectContaining({ name: SKILL, disposition: "synced", operation: "none" }),
    ]);
  }, 60_000);

  test("publishes this project's copy as a new version for `mine`", async ({ setup }) => {
    await diverge(setup.project, setup.remote);
    const before = JSON.parse(await readFile(join(upstreamDir(setup.remote), "meta.json"), "utf8"));
    const { run } = await setup.client.request("conflict.resolve", {
      jobId: WATCH,
      name: SKILL,
      resolution: "mine",
    });
    expect((await finished(setup.client, run.id)).state).toBe("succeeded");

    const upstream = await readFile(join(upstreamDir(setup.remote), "SKILL.md"), "utf8");
    expect(upstream).toContain(LOCAL_BODY);
    const after = JSON.parse(await readFile(join(upstreamDir(setup.remote), "meta.json"), "utf8"));
    expect(after.version).toEqual(expect.any(String));
    expect(after.version).not.toBe(before.version);

    const settled = await jobStatus(WATCH);
    expect(settled.artifacts).toEqual([
      expect.objectContaining({ name: SKILL, disposition: "synced", operation: "none" }),
    ]);
  }, 60_000);

  test("publishes only the kind waiting on `mine`, not an agent of the same name", async ({
    setup,
  }) => {
    await diverge(setup.project, setup.remote);
    const agents = join(setup.project, ".claude", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, `${SKILL}.md`),
      `---\nname: ${SKILL}\ndescription: An agent.\n---\n`,
    );

    const { run } = await setup.client.request("conflict.resolve", {
      jobId: WATCH,
      name: SKILL,
      resolution: "mine",
    });
    expect((await finished(setup.client, run.id)).state).toBe("succeeded");

    expect(existsSync(join(setup.remote, NAMESPACE, "agent", SKILL))).toBe(false);
    expect(await readFile(join(upstreamDir(setup.remote), "SKILL.md"), "utf8")).toContain(
      LOCAL_BODY,
    );
  }, 60_000);

  test("refuses to resolve an artifact that is not waiting on a decision", async ({ setup }) => {
    const refused = await setup.client
      .request("conflict.resolve", {
        jobId: WATCH,
        name: SKILL,
        resolution: "theirs",
      })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: RpcErrorCode.InvalidParams });
  }, 60_000);
});

describe("resolvable", () => {
  it("takes the registry's copy over an edit, and publishes only an edit", () => {
    const edited = { operation: "report", disposition: "publish" } as const;
    const moved = { operation: "pull", disposition: "pull" } as const;
    const settled = { operation: "none", disposition: "synced" } as const;
    expect(resolvable(edited, "theirs")).toBe(true);
    expect(resolvable(edited, "mine")).toBe(true);
    expect(resolvable(moved, "mine")).toBe(false);
    expect(resolvable(settled, "theirs")).toBe(false);
    expect(resolvable(undefined, "theirs")).toBe(false);
    expect(resolvable({ operation: "attention", disposition: "conflict" }, "mine")).toBe(true);
  });
});
