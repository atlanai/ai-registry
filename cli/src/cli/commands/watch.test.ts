import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { emptyRegistryConfig, type Job, type Step } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { Printer } from "#core/output.ts";
import { test } from "#test/kit/fixtures.ts";
import type { CommandContext } from "./index.ts";
import { run } from "./watch.ts";

const daemon = vi.hoisted(() => ({ withDaemon: vi.fn() }));
vi.mock("#daemon/service.ts", () => daemon);

let home: string;
let scope: string;

function context(argv: string[], out: string[] = []): CommandContext {
  return {
    argv,
    cwd: home,
    printer: new Printer({
      format: "json",
      out: { write: (text: string) => out.push(text), isTTY: false },
      err: { write: () => true, isTTY: false },
    }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}

const step = (kind: string, more: Partial<Step> = {}): Step => ({
  name: kind,
  kind,
  needs: [],
  select: [],
  policy: "on",
  extra: {},
  ...more,
});

/** The scope's job, watching `folders` for acme/eng. */
const watching = (folders: string[], root = scope): Job => ({
  id: "job_skills_acme",
  account: "acc_acme",
  schedule: { every: 900, enabled: true },
  steps: [
    step("origins", { to: "acme/eng", select: folders.map((from) => ({ from })) }),
    step("pull", { root, needs: ["origins"] }),
    step("publish", { root, needs: ["pull"] }),
  ],
});

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  scope = join(tmp, "registry");
  vi.stubEnv("AIREG_HOME", join(tmp, "aireg"));
  vi.stubEnv("AIREG_USER_SCOPE", scope);
  daemon.withDaemon.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Runs `aireg watch <argv>` against `jobs`, and returns the job it would save. */
async function watch(jobs: Job[], argv: string[]): Promise<Job | undefined> {
  const config = {
    ...emptyRegistryConfig(),
    accounts: [{ id: "acc_acme", registry: "acme" }],
    jobs,
  };
  await writeConfig(config, 0);
  const sent: { jobs: { upsert: Job[] } }[] = [];
  const client = {
    request: async (method: string, params: { jobs: { upsert: Job[] } }) => {
      if (method === "state.snapshot") return { config: { ...config, revision: 1 } };
      sent.push(params);
      return {};
    },
  };
  daemon.withDaemon.mockImplementation((work: (client: unknown) => unknown) => work(client));
  await run(context(argv));
  return sent[0]?.jobs.upsert[0];
}

const shape = (job: Job | undefined) =>
  job?.steps.map((item) => [item.kind, item.policy, item.needs, item.select.length]);

describe("watch remove", () => {
  test("keeps the rest of the job while another folder is still watched", async () => {
    const saved = await watch([watching(["/gone/a", "/gone/b"])], ["remove", "/gone/a", "-g"]);
    expect(shape(saved)).toEqual([
      ["origins", "on", [], 1],
      ["pull", "on", ["origins"], 0],
      ["publish", "on", ["pull"], 0],
    ]);
  });

  test("goes back to the job aireg add makes once none is left, however the folder is typed", async () => {
    const saved = await watch([watching(["/gone/skills"])], ["remove", "/gone/skills/", "-g"]);
    expect(shape(saved)).toEqual([
      ["pull", "on", [], 0],
      ["publish", "report", ["pull"], 0],
    ]);
  });

  test("refuses a folder this scope does not publish, before the daemon starts", async () => {
    await expect(watch([watching(["/gone/a"])], ["remove", "/elsewhere", "-g"])).rejects.toThrow(
      "/elsewhere is not published from your user scope.",
    );
    expect(daemon.withDaemon).not.toHaveBeenCalled();
  });

  test("names the scope that does publish a folder", async () => {
    const project = join(home, "app");
    await expect(
      watch([watching(["/gone/a"], project)], ["remove", "/gone/a", "-g"]),
    ).rejects.toMatchObject({ hint: expect.stringContaining("published from the project at") });
  });
});

describe("watch list", () => {
  test("names each folder, where it publishes, and the job", async () => {
    const out: string[] = [];
    const accounts = [{ id: "acc_acme", registry: "acme" }];
    await writeConfig(
      { ...emptyRegistryConfig(), accounts, jobs: [watching(["/gone/a", "/gone/b"])] },
      0,
    );
    await run(context(["list"], out));
    const at = { to: "acme/eng", jobId: "job_skills_acme", scope: "user", root: scope };
    expect(JSON.parse(out.join("")).data.watches).toEqual([
      { folder: "/gone/a", ...at },
      { folder: "/gone/b", ...at },
    ]);
  });
});
