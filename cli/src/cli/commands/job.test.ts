import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { emptyRegistryConfig, type Job, type StepPolicy } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { AiregError } from "#core/errors.ts";
import { Printer } from "#core/term/printer.ts";
import { test } from "#test/kit/fixtures.ts";
import type { CommandContext } from "./command.ts";
import { run } from "./job.ts";

const daemon = vi.hoisted(() => ({ withDaemon: vi.fn() }));
vi.mock("#daemon/process/lifecycle.ts", () => daemon);

let home: string;

function context(argv: string[], out: string[] = [], err: string[] = []): CommandContext {
  return {
    argv,
    cwd: home,
    printer: new Printer({
      format: "json",
      out: { write: (text: string) => out.push(text), isTTY: false },
      err: { write: (text: string) => err.push(text), isTTY: false },
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

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  vi.stubEnv("AIREG_HOME", home);
  daemon.withDaemon.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
});

describe("a job command that fails validation", () => {
  const failing = [
    ["add"],
    ["add", "--registry", "undeclared"],
    ["add", "--registry", "undeclared", "--interval", "5"],
    ["enable", "zz-nope"],
    ["disable", "zz-nope"],
    ["remove", "zz-nope"],
    ["start", "zz-nope"],
    ["retry"],
    ["cancel"],
    ["retry", "zz-nope"],
    ["cancel", "zz-nope"],
    ["runs", "zz-nope"],
  ];

  test("does not start the daemon", async () => {
    for (const argv of failing) {
      await expect(run(context(argv)), argv.join(" ")).rejects.toThrow(AiregError);
    }
    expect(daemon.withDaemon).not.toHaveBeenCalled();
  });
});

describe("job add --interval", () => {
  test.each(["600s", "1.5", "1e3", " 600"])(
    "refuses %j, which is not whole seconds",
    async (value) => {
      await expect(
        run(context(["add", "--registry", "undeclared", "--interval", value])),
      ).rejects.toThrow(/--interval must be a whole number of seconds/);
    },
  );
});

describe("a job named by a name other than its id", () => {
  const job: Job = {
    id: "job_contributed_1",
    name: "nightly",
    account: "acc_demo",
    schedule: { every: 300, enabled: true },
    steps: [
      { name: "pull", kind: "pull", needs: [], root: "/", select: [], policy: "on", extra: {} },
    ],
  };

  test("is removed by its id, which the output reports", async () => {
    const config = {
      ...emptyRegistryConfig(),
      accounts: [{ id: "acc_demo", registry: "acme" }],
      jobs: [job],
    };
    await writeConfig(config, 0);
    const sent: unknown[] = [];
    const client = {
      request: async (method: string, params: unknown) => {
        if (method === "state.snapshot") return { config: { ...config, revision: 1 } };
        sent.push(params);
        return {};
      },
    };
    daemon.withDaemon.mockImplementation((work: (client: unknown) => unknown) => work(client));
    const out: string[] = [];
    await run(context(["remove", "nightly"], out));
    expect(sent).toEqual([{ expectedRevision: 1, jobs: { remove: ["job_contributed_1"] } }]);
    expect(JSON.parse(out.join(""))).toEqual({ ok: true, data: { jobId: "job_contributed_1" } });
  });
});

const step = (kind: string, root = "/scope", policy: StepPolicy = "on", needs: string[] = []) => ({
  name: kind,
  kind,
  needs,
  root,
  select: [],
  policy,
  extra: {},
});
const job = (id: string, steps: Job["steps"], enabled = true): Job => ({
  id,
  account: "acc_acme",
  schedule: { every: 900, enabled },
  steps,
});

describe("removing the job that keeps a project's installs up to date", () => {
  const installs = "registries:\n  acme: ../acme\nartifacts:\n  - acme/engineering\n";

  test.each([
    ["warns", true, installs, "on", true],
    ["says nothing for a disabled job", false, installs, "on", false],
    ["says nothing for a job that never pulled", false, installs, "off", true],
    ["still succeeds when the manifest cannot be read", false, "artifacts: [oops\n", "on", true],
  ] as const)("%s", async (_, warns, manifest, policy, enabled) => {
    const project = join(home, "project");
    await mkdir(join(project, ".registry"), { recursive: true });
    await writeFile(join(project, ".registry", "manifest.yml"), manifest);
    const config = {
      ...emptyRegistryConfig(),
      accounts: [{ id: "acc_acme", registry: "acme" }],
      jobs: [job("job_skills_acme", [step("pull", project, policy)], enabled)],
    };
    await writeConfig(config, 0);
    const client = {
      request: async (method: string) => {
        if (method === "state.snapshot") return { config: { ...config, revision: 1 } };
        await writeConfig({ ...config, jobs: [] }, 1);
        return {};
      },
    };
    daemon.withDaemon.mockImplementation((work: (client: unknown) => unknown) => work(client));
    const err: string[] = [];
    await run(context(["remove", "job_skills_acme"], [], err));
    expect(err.join("").includes("no longer kept up to date")).toBe(warns);
  });
});
