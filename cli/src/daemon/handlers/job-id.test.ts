import { describe, expect, test } from "vitest";
import { emptyRegistryConfig, type RegistryConfig, type Step } from "#core/config/model.ts";
import { contributedJobId, skillsJobId } from "./job-id.ts";

describe("a job's default id", () => {
  test("slugifies the registry name so spaces are legal", () => {
    const account = { id: "acct_1", registry: "Acme Demo" };
    expect(contributedJobId(emptyRegistryConfig(), {}, account, "probe")).toBe(
      "job_probe_acme-demo",
    );
  });
});

describe("a second job for the same registry", () => {
  const step = (kind: string, root?: string): Step => ({
    name: kind,
    kind,
    needs: [],
    ...(root === undefined ? {} : { root }),
    select: [],
    policy: "on",
    extra: {},
  });
  const job = (id: string, steps: Step[]) => ({
    id,
    account: "acct_1",
    schedule: { every: 900, enabled: true },
    steps,
  });
  const config: RegistryConfig = {
    ...emptyRegistryConfig(),
    jobs: [job("job_skills_acme", [step("pull", "/p")]), job("job_probe_acme", [step("probe")])],
  };
  const account = { id: "acct_1", registry: "acme" };

  test("names the job that already has the folder or the kind", () => {
    expect(() => skillsJobId(config, { name: "other" }, account, "acme", "/p", "project")).toThrow(
      "/p already syncs with acme as job job_skills_acme. Leave out --name to update that job",
    );
    expect(() => contributedJobId(config, { name: "other" }, account, "probe")).toThrow(
      "acme already has a probe job, job_probe_acme. Leave out --name to update it.",
    );
  });
});
