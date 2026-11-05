import { describe, expect, test } from "vitest";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { rpcError } from "#daemon/rpc/errors.ts";
import type { ProtocolError } from "#daemon/rpc/protocol.ts";
import { job, pageLimit, scope, syncPolicy } from "./params.ts";

const STEP = {
  name: "pull",
  kind: "pull",
  needs: [],
  root: "/tmp/registry-project",
  select: [],
  policy: "on",
  extra: {},
};

const VALID = {
  id: "watch_demo",
  account: "acc_demo",
  schedule: { every: 300, enabled: true },
  steps: [STEP],
};

function rejected(value: unknown): ProtocolError {
  try {
    job(value);
  } catch (error) {
    return rpcError(error);
  }
  throw new Error("The job was accepted");
}

describe("job input", () => {
  test("rebuilds a job field by field, ignoring what it does not know", () => {
    expect(job({ ...VALID, sneaked: "value" })).toEqual(VALID);
  });

  test("takes back a job as the daemon hands it out, a selector's targets under both keys", () => {
    const stored = job({
      ...VALID,
      steps: [{ ...STEP, select: [{ from: "/tmp/s", harness: ["claude"] }] }],
    });
    const echoed = JSON.parse(JSON.stringify(stored));
    expect(echoed.steps[0].select).toEqual([
      { from: "/tmp/s", target: ["claude-code"], harness: ["claude"] },
    ]);
    expect(job(echoed)).toEqual(stored);
    const disabled = { ...echoed, schedule: { ...echoed.schedule, enabled: false } };
    expect(job(disabled).schedule.enabled).toBe(false);
  });

  test("keeps a step's own fields, which aireg never names", () => {
    const parsed = job({
      ...VALID,
      steps: [{ name: "probe", kind: "probe", content: "store" }],
    });
    expect(parsed.steps[0]?.extra).toEqual({ content: "store" });
  });

  test.each([
    ["a job with no steps", { steps: [] }, "steps"],
    ["an interval below the scheduler's floor", { schedule: { every: 30 } }, "every"],
    ["an identifier that is not usable as a key", { id: "../escape" }, "id"],
    [
      "an enabled flag that is not a boolean",
      { schedule: { every: 300, enabled: "yes" } },
      "enabled",
    ],
    ["a relative root", { steps: [{ ...STEP, root: "project" }] }, "absolute path"],
    ["a scope step with no root", { steps: [{ ...STEP, root: undefined }] }, "needs a `root`"],
    ["a typo in a built-in step", { steps: [{ ...STEP, polcy: "off" }] }, 'does not take "polcy"'],
    ["a step that needs one it does not have", { steps: [{ ...STEP, needs: ["x"] }] }, "needs"],
  ])("rejects %s", (_, change, field) => {
    const error = rejected({ ...VALID, ...change });
    expect(error.code).toBe(RpcErrorCode.InvalidParams);
    expect(error.message).toContain(field);
  });
});

describe("syncPolicy optional axes", () => {
  test("leaves adopt and claim absent unless a caller names them", () => {
    expect(syncPolicy({ policy: { pull: "on" } }, "policy")).toEqual({
      pull: "on",
      publish: "off",
      delete: "off",
    });
    expect(syncPolicy({ policy: { adopt: "on", claim: "off" } }, "policy")).toMatchObject({
      adopt: "on",
      claim: "off",
    });
    expect(() => syncPolicy({ policy: { adopt: "yes" } }, "policy")).toThrow();
  });
});

describe("scope input", () => {
  test("names only the scopes it accepts", () => {
    expect(() => scope({ scope: "local" }, "scope", "user")).toThrow(
      "`scope` must be user or project.",
    );
  });
});

describe("page limit input", () => {
  test("takes the fallback when absent and refuses a limit outside one page", () => {
    expect(pageLimit({}, "limit", undefined)).toBeUndefined();
    expect(pageLimit({}, "limit", 200)).toBe(200);
    expect(pageLimit({ limit: 500 }, "limit", undefined)).toBe(500);
    for (const limit of [0, 501]) {
      expect(() => pageLimit({ limit }, "limit", 200)).toThrow(
        "The limit must be between 1 and 500.",
      );
    }
  });
});
