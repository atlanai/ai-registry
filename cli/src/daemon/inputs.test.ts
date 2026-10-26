import { describe, expect, it } from "vitest";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ProtocolError } from "#daemon/rpc/protocol.ts";
import { job, scope, syncPolicy } from "./inputs.ts";

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
    if (error instanceof ProtocolError) return error;
    throw error;
  }
  throw new Error("The job was accepted");
}

describe("job input", () => {
  it("rebuilds a job field by field, ignoring what it does not know", () => {
    expect(job({ ...VALID, sneaked: "value" })).toEqual(VALID);
  });

  it("takes back a job as the daemon hands it out, a selector's targets under both keys", () => {
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

  it("keeps a step's own fields, which aireg never names", () => {
    const parsed = job({
      ...VALID,
      steps: [{ name: "probe", kind: "probe", content: "store" }],
    });
    expect(parsed.steps[0]?.extra).toEqual({ content: "store" });
  });

  it.each([
    ["a job with no steps", { steps: [] }, "steps"],
    ["an interval below the scheduler's floor", { schedule: { every: 30 } }, "every"],
    ["an identifier that is not usable as a key", { id: "../escape" }, "id"],
    [
      "an enabled flag that is not a boolean",
      { schedule: { every: 300, enabled: "yes" } },
      "enabled",
    ],
    // A relative root would resolve against the daemon's directory.
    ["a relative root", { steps: [{ ...STEP, root: "project" }] }, "absolute path"],
    // Config refuses these on the next read, so the daemon must not store them.
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
  it("leaves adopt and claim absent unless a caller names them", () => {
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
  it("names only the scopes it accepts", () => {
    expect(() => scope({ scope: "local" }, "scope", "user")).toThrow(
      "`scope` must be user or project.",
    );
  });
});
