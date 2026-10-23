import { describe, expect, it } from "vitest";
import { classify } from "./decide.ts";
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
    expect(outcomes.get("agent:helper")?.operation).toBe("report");
    expect(outcomes.get("skill:lint")?.operation).toBe("publish");
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
    expect(outcomes.get("skill:lint")?.operation).toBe("ignore");
    expect(mutates).toBe(false);
  });

  it("keeps two local artifacts that share a name apart, and a narrowed run to its kind", () => {
    const both = scan([
      { name: "lint", kind: "agent" },
      { name: "lint", kind: "skill" },
    ] as Scan["local"]);
    const all = classify(both, job, "acme", undefined, "sync", new Map());
    expect([...all.outcomes.keys()].sort()).toEqual(["agent:lint", "skill:lint"]);

    const narrowed = classify(both, job, "acme", new Set(["skill:lint"]), "sync", new Map());
    expect([...narrowed.outcomes.values()]).toEqual([
      expect.objectContaining({ artifact: "lint", kind: "skill", operation: "publish" }),
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
    expect(outcomes.has("skill:shared/evals")).toBe(false);
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
    target: "claude",
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
    expect(outcomes.get("skill:ws/hello")).toMatchObject({
      operation: "ignore",
      detail: "a folder of yours with this name is in use",
    });
    expect(writes.has("ws/hello")).toBe(false);
  });

  it("installs it when claiming is asked for, or when the lock already holds it", () => {
    const claiming = { ...job, policy: { ...job.policy, claim: "on" as const } };
    expect(
      classify(withFolder(), claiming, "acme", undefined, "sync", new Map()).outcomes.get(
        "skill:ws/hello",
      )?.operation,
    ).toBe("pull");
    const locked = withFolder({ "ws/hello": { registry: "acme", kind: "skill" } });
    expect(
      classify(locked, job, "acme", undefined, "sync", new Map()).outcomes.get("skill:ws/hello")
        ?.operation,
    ).toBe("pull");
  });
});
