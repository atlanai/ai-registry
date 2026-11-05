import { expect, test } from "vitest";
import { jobRoot } from "#core/config/jobs.ts";
import type { Step } from "#core/config/model.ts";
import { workOf } from "./work.ts";

const artifacts: Step = {
  name: "sync",
  kind: "artifacts",
  needs: [],
  root: "/work/project",
  select: [],
  policy: "on",
  extra: {},
};

test("reads a job written with the composite artifacts step as the scope and policy it expands to", () => {
  const work = workOf({ id: "job_1", account: "acc_1", steps: [artifacts] });
  expect(work.root).toBe("/work/project");
  expect(work.scope).toBe("project");
  expect(work.policy).toMatchObject({ pull: "on", publish: "on", delete: "on" });
  expect(work.steps.map((step) => step.kind)).toEqual(["pull", "publish", "prune"]);
});

test("finds a composite step's root as the job's", () => {
  expect(jobRoot({ steps: [artifacts] })).toBe("/work/project");
});
