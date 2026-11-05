import { describe, expect, test } from "vitest";
import type { Step, StepPolicy } from "#core/config/model.ts";
import { operation, policyOf } from "./policy.ts";

const step = (kind: string, policy: StepPolicy): Step => ({
  name: kind,
  kind,
  needs: [],
  root: "/home",
  select: [],
  policy,
  extra: {},
});

describe("sync policy", () => {
  test("lets first publishes of local work follow publish when no adopt step is declared", () => {
    const policy = policyOf([step("pull", "on"), step("publish", "on")]);
    expect(policy.adopt).toBeUndefined();
    expect(operation("adopt", policy)).toBe("publish");
    expect(operation("adopt", policyOf([step("publish", "report")]))).toBe("report");
  });

  test("gives first publishes their own axis, apart from edits", () => {
    const off = policyOf([step("publish", "on"), step("adopt", "off")]);
    expect(operation("adopt", off)).toBe("ignore");
    expect(operation("publish", off)).toBe("publish");
    const apply = policyOf([step("publish", "report"), step("adopt", "on")]);
    expect(operation("adopt", apply)).toBe("publish");
    expect(operation("publish", apply)).toBe("report");
    expect(operation("adopt", policyOf([step("adopt", "report")]))).toBe("report");
  });

  test("leaves claiming off unless a claim step asks for it", () => {
    expect(policyOf([step("pull", "on")]).claim).toBeUndefined();
    expect(policyOf([step("pull", "on"), step("claim", "on")]).claim).toBe("on");
  });
});
