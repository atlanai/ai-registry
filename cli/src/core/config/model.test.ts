import { describe, expect, test } from "vitest";
import { expandSteps, orderSteps } from "./jobs.ts";
import { isNamespaceAddress, isStepPolicy, type Step } from "./model.ts";

function step(over: Partial<Step> = {}): Step {
  return {
    name: "pull",
    kind: "pull",
    needs: [],
    select: [],
    policy: "on",
    extra: {},
    ...over,
  };
}

describe("expandSteps", () => {
  test("replaces a composite with its leaves and rewires what followed it", () => {
    const expanded = expandSteps([
      step({ name: "mine", kind: "origins" }),
      step({ name: "sync", kind: "artifacts", needs: ["mine"], root: "/tmp/scope" }),
      step({ name: "after", kind: "probe", needs: ["sync"] }),
    ]);
    expect(expanded.map((item) => item.name)).toEqual([
      "mine",
      "sync/pull",
      "sync/publish",
      "sync/prune",
      "after",
    ]);
    // The first leaf inherits the composite's own dependencies; the rest gate on it.
    expect(expanded[1]?.needs).toEqual(["mine"]);
    expect(expanded[2]?.needs).toEqual(["sync/pull"]);
    expect(expanded[3]?.needs).toEqual(["sync/pull"]);
    // Anything that followed the composite waits for every leaf of it.
    expect(expanded[4]?.needs).toEqual(["sync/pull", "sync/publish", "sync/prune"]);
  });

  test("leaves a job of plain steps alone", () => {
    const steps = [step(), step({ name: "publish", kind: "publish", needs: ["pull"] })];
    expect(expandSteps(steps)).toEqual(steps);
  });
});

describe("orderSteps", () => {
  test("returns an order that satisfies every dependency", () => {
    const result = orderSteps([
      step({ name: "c", needs: ["b"] }),
      step({ name: "b", needs: ["a"] }),
      step({ name: "a" }),
    ]);
    expect("order" in result && result.order.map((item) => item.name)).toEqual(["a", "b", "c"]);
  });

  test("names the cycle rather than looping", () => {
    const result = orderSteps([
      step({ name: "a", needs: ["b"] }),
      step({ name: "b", needs: ["a"] }),
    ]);
    expect("cycle" in result && result.cycle).toContain("a");
  });
});

describe("isNamespaceAddress", () => {
  test("takes <registry>/<namespace>, each part in the spec's name grammar", () => {
    expect(isNamespaceAddress("acme/engineering")).toBe(true);
    expect(isNamespaceAddress("acme-2/eng-1")).toBe(true);
  });

  test("refuses anything else", () => {
    for (const value of [
      "acme",
      "acme/eng/x",
      "/eng",
      "Acme/Eng",
      "acme/eng # note",
      "acme/-x-",
      "acme/e\nng",
      "acme/e\u202Eng",
    ]) {
      expect(isNamespaceAddress(value), value).toBe(false);
    }
  });
});

describe("isStepPolicy", () => {
  test("takes on, report and off, and nothing else", () => {
    for (const value of ["on", "report", "off"]) expect(isStepPolicy(value)).toBe(true);
    for (const value of ["apply", "yes", ""]) expect(isStepPolicy(value)).toBe(false);
  });
});
