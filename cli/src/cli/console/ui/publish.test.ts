import { describe, expect, test, vi } from "vitest";
import type { ArtifactGroup, ArtifactRow, ConsoleState } from "#core/console/model.ts";
import { importNow, type PlanContext, planForLine, planForRow } from "./publish.ts";

function row(name: string, overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    key: `eng/${name}`,
    name,
    namespace: "eng",
    state: "edited",
    copy: `/work/${name}`,
    ...overrides,
  } as ArtifactRow;
}

const context: PlanContext = {
  state: {
    scope: "user",
    account: { registry: "market", defaultNamespace: "mine" },
  } as ConsoleState,
  upstream: undefined,
};

describe("planForRow", () => {
  test("sends an edit back to the namespace it came from", () => {
    const plan = planForRow(row("lint"), context);
    expect(plan).toMatchObject({ alias: undefined, namespace: "eng", send: [row("lint")] });
    expect(plan?.command).toBe("aireg publish -g --yes -- lint");
  });

  test("tells work authored here which registry and namespace to land in", () => {
    const authored = row("audit", { state: "unpublished", namespace: undefined });
    expect(planForRow(authored, context)).toMatchObject({
      alias: "market",
      namespace: "mine",
      command: "aireg publish -g --to mine --yes -- /work/audit",
    });
  });

  test("has nothing to send for an unchanged row, or a folder a job carries", () => {
    expect(planForRow(row("lint", { state: "ok" }), context)).toBeUndefined();
    expect(planForRow(row("lint", { carriedBy: "job_1" }), context)).toBeUndefined();
  });
});

describe("planForLine", () => {
  test("names a group's pending artifacts as skipped before the key is pressed", () => {
    const group = {
      key: "eng",
      label: "eng",
      authoredHere: false,
      rows: [row("lint"), row("deploy", { state: "pending" }), row("format", { state: "ok" })],
    } as ArtifactGroup;
    const plan = planForLine({ kind: "group", group }, context);
    expect(plan?.send.map((sent) => sent.name)).toEqual(["lint"]);
    expect(plan?.skip.map((skipped) => skipped.row.name)).toEqual(["deploy"]);
    expect(plan).toMatchObject({ title: "eng", namespace: "eng", wholeGroupOnly: false });
  });
});

describe("importNow", () => {
  test("runs the job that carries an edited folder, and nothing for any other row", () => {
    const run = vi.fn();
    expect(importNow(row("lint", { carriedBy: "job_1" }), run)).toBe(true);
    expect(run).toHaveBeenCalledWith("importing lint", expect.objectContaining({}));
    expect(importNow(row("lint"), run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
