import { describe, expect, it } from "vitest";
import { classify, type SyncOutcome } from "./decide.ts";
import type { Scan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

const job: ScopeWork = {
  id: "job_skills",
  root: "/home",
  scope: "user",
  account: "acc_1",
  policy: { pull: "on", publish: "on", delete: "on" },
  steps: [],
};

/** What classify settled for one artifact, found by its kind and name. */
function outcomeFor(outcomes: ReadonlyMap<string, SyncOutcome>, kind: string, artifact: string) {
  return [...outcomes.values()].find((item) => item.kind === kind && item.artifact === artifact);
}

function scan(local: Scan["local"]): Scan {
  return { items: [], local, undeclared: [], publisher: new Map() } as unknown as Scan;
}

describe("classify", () => {
  it("holds a local artifact of a kind the adapter cannot publish, and publishes the rest", () => {
    const { outcomes, mutates } = classify(
      scan([
        { name: "helper", kind: "agent" },
        { name: "lint", kind: "skill" },
      ] as Scan["local"]),
      job,
      "acme",
      undefined,
      "sync",
      new Map(),
      (kind) => kind === "skill",
    );
    expect(outcomeFor(outcomes, "agent", "helper")?.operation).toBe("report");
    expect(outcomeFor(outcomes, "skill", "lint")?.operation).toBe("publish");
    expect(mutates).toBe(true);
  });

  it("skips local work for a registry that takes no publishes at all", () => {
    const { outcomes, mutates } = classify(
      scan([{ name: "lint", kind: "skill" }] as Scan["local"]),
      job,
      "acme",
      undefined,
      "sync",
      new Map(),
      () => false,
    );
    expect(outcomeFor(outcomes, "skill", "lint")?.operation).toBe("ignore");
    expect(mutates).toBe(false);
  });

  it("keeps two local artifacts that share a name apart", () => {
    const both = scan([
      { name: "lint", kind: "agent" },
      { name: "lint", kind: "skill" },
    ] as Scan["local"]);
    const all = classify(both, job, "acme", undefined, "sync", new Map());
    expect([...all.outcomes.values()]).toEqual([
      expect.objectContaining({ artifact: "lint", kind: "agent" }),
      expect.objectContaining({ artifact: "lint", kind: "skill" }),
    ]);
  });
});

describe("classify across registries", () => {
  it("leaves a name whose lock row another registry owns to that registry's job", () => {
    const served = {
      name: "shared/evals",
      kind: "skill",
      source: "second",
      path: "artifacts/shared/skill/evals",
      disposition: "archive",
      digests: { base: "sha256:a", local: undefined, upstream: "sha256:a" },
    };
    const shared = {
      items: [served],
      local: [],
      undeclared: [],
      publisher: new Map(),
      pinned: {
        version: 1,
        registries: {},
        artifacts: { "shared/evals": { registry: "first" } },
      },
      acquired: [],
    } as unknown as Scan;
    const { outcomes, mutates } = classify(shared, job, "second", undefined, "sync", new Map());
    expect(outcomeFor(outcomes, "skill", "shared/evals")).toBeUndefined();
    expect(mutates).toBe(false);
  });
});

describe("a folder of yours with a registry name", () => {
  const served = {
    name: "ws/hello",
    kind: "skill",
    source: "acme",
    path: "artifacts/ws/skill/hello",
    disposition: "pull",
    digests: { base: undefined, local: undefined, upstream: "sha256:a" },
  };
  const yours = {
    name: "hello",
    kind: "skill",
    from: "/home/.claude/skills/hello",
    target: "claude-code",
    suggestedPath: "skills/hello",
    description: undefined,
    elsewhere: [],
  };
  const withFolder = (pinned: Record<string, unknown> = {}) =>
    ({
      items: [served],
      local: [],
      undeclared: [yours],
      publisher: new Map(),
      pinned: { version: 1, registries: {}, artifacts: pinned },
      acquired: [],
    }) as unknown as Scan;

  it("keeps the registry's copy out, without asking anyone to act", () => {
    const { outcomes, writes } = classify(withFolder(), job, "acme", undefined, "sync", new Map());
    expect(outcomeFor(outcomes, "skill", "ws/hello")).toMatchObject({
      operation: "ignore",
      detail: "a folder of yours with this name is in use",
    });
    expect(writes.has("ws/hello")).toBe(false);
  });

  it("installs it when claiming is asked for, or when the lock already holds it", () => {
    const claiming = { ...job, policy: { ...job.policy, claim: "on" as const } };
    const claimed = classify(withFolder(), claiming, "acme", undefined, "sync", new Map());
    expect(outcomeFor(claimed.outcomes, "skill", "ws/hello")?.operation).toBe("pull");
    const locked = withFolder({ "ws/hello": { registry: "acme", kind: "skill" } });
    const held = classify(locked, job, "acme", undefined, "sync", new Map());
    expect(outcomeFor(held.outcomes, "skill", "ws/hello")?.operation).toBe("pull");
  });
});

describe("taking the registry's side", () => {
  const item = (name: string, disposition: string, upstream: string | undefined) => ({
    name,
    kind: "skill",
    source: "acme",
    path: `artifacts/ws/skill/${name}`,
    disposition,
    digests: { base: undefined, local: undefined, upstream },
  });

  it("removes what the registry deleted, and leaves one it would not serve a pull", () => {
    const taken = {
      items: [item("gone", "pull-delete", undefined), item("held", "unavailable", undefined)],
      local: [],
      undeclared: [],
      publisher: new Map(),
      pinned: { version: 1, registries: {}, artifacts: {} },
      acquired: [],
    } as unknown as Scan;
    const overrides = new Map([
      ["skill:gone", "pull" as const],
      ["skill:held", "pull" as const],
    ]);
    const { outcomes } = classify(taken, job, "acme", undefined, "sync", overrides);
    expect(outcomeFor(outcomes, "skill", "gone")?.operation).toBe("remove-local");
    expect(outcomeFor(outcomes, "skill", "held")?.operation).toBe("pull");
  });
});
