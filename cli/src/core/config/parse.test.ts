import { describe, expect, test } from "vitest";
import { formatConfig, parseConfig } from "./parse.ts";

const HEAD = `schemaVersion: 1
revision: 3
accounts:
  - id: acc_1
    registry: acme
`;

function config(jobs: string): string {
  return `${HEAD}jobs:\n${jobs}`;
}

describe("parseConfig", () => {
  test("reads a job as a graph of steps", () => {
    const parsed = parseConfig(
      config(`  - id: job_1
    name: this machine
    account: acc_1
    schedule: { every: 15m, enabled: true }
    steps:
      - name: mine
        kind: origins
        to: acme/my-workspace
        select:
          - { from: /tmp/skills, match: "!(draft-*)" }
      - { name: sync, kind: artifacts, needs: [mine], root: /tmp/scope }
`),
    );
    const job = parsed.jobs[0];
    expect(job?.name).toBe("this machine");
    expect(job?.schedule).toEqual({ every: 900, enabled: true });
    expect(job?.steps.map((item) => item.kind)).toEqual(["origins", "artifacts"]);
    expect(job?.steps[0]?.select[0]).toEqual({ from: "/tmp/skills", match: "!(draft-*)" });
    expect(job?.steps[1]?.needs).toEqual(["mine"]);
  });

  test("reads a selector's `target` or `harness`, its aireg 0.1 name, and writes `harness`", () => {
    const step = (select: string) =>
      config(`  - id: job_1
    account: acc_1
    steps:
      - { name: mine, kind: origins, to: acme/ws, select: ${select} }
`);
    for (const key of ["target", "harness"]) {
      for (const id of ["claude", "claude-code"]) {
        const parsed = parseConfig(step(`{ from: /tmp/skills, ${key}: [${id}] }`));
        expect(parsed.jobs[0]?.steps[0]?.select[0]).toEqual({
          from: "/tmp/skills",
          target: ["claude-code"],
          harness: ["claude"],
        });
        expect(formatConfig(parsed)).toContain("harness:\n              - claude\n");
        expect(formatConfig(parsed)).not.toContain("target");
        expect(parseConfig(formatConfig(parsed))).toEqual(parsed);
      }
    }
    expect(() =>
      parseConfig(step("{ from: /tmp/skills, target: [claude], harness: [codex] }")),
    ).toThrow("names different targets under `target` and `harness`");
  });

  test("takes a selector with both keys when they name the same targets, as the daemon hands it out", () => {
    const parsed = parseConfig(
      config(`  - id: job_1
    account: acc_1
    steps:
      - { name: mine, kind: origins, to: acme/ws, select: { from: /tmp/skills, target: [claude-code, universal], harness: [agents, claude] } }
`),
    );
    expect(parsed.jobs[0]?.steps[0]?.select[0]).toMatchObject({
      target: ["claude-code", "universal"],
      harness: ["claude", "agents"],
    });
  });

  test("takes a duration in seconds, minutes or hours", () => {
    const every = (value: string) =>
      parseConfig(
        config(`  - id: job_1
    account: acc_1
    schedule: { every: ${value} }
    steps:
      - { name: pull, kind: pull, root: /tmp/scope }
`),
      ).jobs[0]?.schedule.every;
    expect(every("90")).toBe(90);
    expect(every("15m")).toBe(900);
    expect(every("2h")).toBe(7200);
  });

  test("refuses a schedule shorter than a minute", () => {
    expect(() =>
      parseConfig(
        config(`  - id: job_1
    account: acc_1
    schedule: { every: 30s }
    steps:
      - { name: pull, kind: pull, root: /tmp/scope }
`),
      ),
    ).toThrow(/at least 60 seconds/);
  });

  test("refuses a step that needs one the job does not have", () => {
    expect(() =>
      parseConfig(
        config(`  - id: job_1
    account: acc_1
    steps:
      - { name: pull, kind: pull, root: /tmp/scope, needs: [missing] }
`),
      ),
    ).toThrow(/needs "missing"/);
  });

  test("refuses a scope step with no root, and an origins step with no destination", () => {
    const bare = (step: string) =>
      parseConfig(config(`  - id: job_1\n    account: acc_1\n    steps:\n      - ${step}\n`));
    expect(() => bare("{ name: pull, kind: pull }")).toThrow(/needs a `root`/);
    expect(() => bare("{ name: mine, kind: origins }")).toThrow(/needs a `to`/);
  });

  test("keeps an adapter's own fields but refuses a typo on a built-in step", () => {
    const parsed = parseConfig(
      config(`  - id: job_1
    account: acc_1
    steps:
      - { name: probe, kind: probe, content: store }
`),
    );
    expect(parsed.jobs[0]?.steps[0]?.extra).toEqual({ content: "store" });
    expect(() =>
      parseConfig(
        config(`  - id: job_1
    account: acc_1
    steps:
      - { name: pull, kind: pull, root: /tmp/scope, contnet: store }
`),
      ),
    ).toThrow(/does not take "contnet"/);
  });

  test("refuses an adapter pin under a name that is not an adapter id", () => {
    expect(
      parseConfig(`${HEAD}jobs: []\nadapters:\n  acme: ./adapters/acme/1.0.0/adapter.mjs\n`)
        .adapters,
    ).toEqual({
      acme: "./adapters/acme/1.0.0/adapter.mjs",
    });
    expect(() => parseConfig(`${HEAD}jobs: []\nadapters:\n  ../acme: ./x.mjs\n`)).toThrow(
      '`adapters` names "../acme", which is not an adapter id.',
    );
  });

  test("round-trips through format", () => {
    const text = config(`  - id: job_1
    account: acc_1
    schedule: { every: 900, enabled: false }
    steps:
      - { name: pull, kind: pull, root: /tmp/scope, policy: report }
`);
    expect(parseConfig(formatConfig(parseConfig(text)))).toEqual(parseConfig(text));
  });

  test("writes an account's registry as `registry:`", () => {
    const written = formatConfig(parseConfig(config("  []\n")));
    expect(written).toContain("    registry: acme\n");
    expect(parseConfig(written).accounts[0]?.registry).toBe("acme");
  });

  test("refuses a default namespace the grammar refuses, as every writer does", () => {
    expect(() => parseConfig(`${HEAD}jobs: []\ndefaults:\n  namespace: Acme/Eng\n`)).toThrow(
      "`defaults.namespace` must be <registry>/<namespace>.",
    );
  });

  test("refuses a step destination the grammar refuses", () => {
    const origins = (to: string) =>
      parseConfig(
        config(
          `  - id: job_1\n    account: acc_1\n    steps:\n      - { name: mine, kind: origins, to: ${to}, select: { from: /tmp } }\n`,
        ),
      );
    expect(() => origins("acme/eng")).not.toThrow();
    expect(() => origins("Acme/Eng")).toThrow(
      "`jobs[0].steps[0].to` must be <registry>/<namespace>.",
    );
  });
});
