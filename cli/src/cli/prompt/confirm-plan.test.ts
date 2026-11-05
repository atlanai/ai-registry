import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { unhandled } from "#cli/render/tools.ts";
import { emptyLock, type LockArtifact } from "#core/lock.ts";
import type { Plan, Selected } from "#core/plan/model.ts";
import { roots, type Scope } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/table.ts";
import { Printer } from "#core/term/printer.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import { withoutKind } from "#test/kit/target.ts";
import { chooseTargets, methodIsMeaningful } from "./choose.ts";
import {
  confirmPlan,
  destroys,
  linkedTargets,
  type PlanContext,
  unreached,
} from "./confirm-plan.ts";
import { equivalent } from "./equivalent.ts";

const targetTable = resolveTargets({ HOME: "/home/dev" });
/** A table where Codex has nowhere to put an agent, for what is said about a kind left out. */
const noCodexAgents = withoutKind(targetTable, "codex", "agent");

describe("methodIsMeaningful", () => {
  // Codex places a plugin as its parts; Cursor has nowhere for an agent.
  test.each([
    ["one target, where a link and a copy land identically", ["claude-code"], undefined, false],
    ["two target roots that would each receive it", ["claude-code", "codex"], undefined, true],
    ["nothing selected", [], undefined, false],
    ["only one target that can place the kind", ["claude-code"], ["plugin"], false],
    ["a target that takes a plugin as its parts", ["claude-code", "codex"], ["plugin"], true],
    [
      "several targets that can place the kind",
      ["claude-code", "codex", "cursor", "universal"],
      ["skill"],
      true,
    ],
    [
      "targets that can each place one of the kinds",
      ["claude-code", "cursor"],
      ["plugin", "agent"],
      true,
    ],
  ] as const)("given %s", (_, ids, kinds, meaningful) => {
    expect(methodIsMeaningful(targetTable, ids, "project", "/w", kinds)).toBe(meaningful);
  });
});

describe("unreached", () => {
  test("names the chosen targets no link was made for", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "stage", name: "a", source: "kit", path: "skills/lint", to: "/t" },
        { kind: "link", name: "a", target: "claude-code", from: "/f", to: "/t", copy: false },
      ],
    };
    expect(unreached(plan, ["claude-code", "codex", "universal"])).toEqual(["codex", "universal"]);
  });

  test("is empty when every target got something", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "link", name: "a", target: "claude-code", from: "/f", to: "/t", copy: false },
      ],
    };
    expect(unreached(plan, ["claude-code"])).toEqual([]);
  });

  test("counts a target reached through a folder it reads", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "link", name: "a", target: "universal", from: "/f", to: "/t", copy: false },
      ],
    };
    // Codex reads skills from `.agents`, so a link there reaches it.
    expect(unreached(plan, ["codex", "claude-code"], targetTable)).toEqual(["claude-code"]);
  });
});

describe("linkedTargets", () => {
  test("names each target once, however many members point into it", () => {
    // A plugin is one entry in the plan but one link per member per target,
    // so the line otherwise repeats each target for every member.
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "link", name: "core", target: "codex", from: "/f", to: "/t1", copy: false },
        { kind: "link", name: "core", target: "codex", from: "/f", to: "/t2", copy: false },
        { kind: "link", name: "core", target: "pi", from: "/f", to: "/t3", copy: false },
      ],
    };

    expect(linkedTargets(plan).get("core")).toEqual(["codex", "pi"]);
  });

  test("has no entry for an artifact that was only staged", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [{ kind: "stage", name: "lint", source: "kit", path: "skills/lint", to: "/t" }],
    };

    expect(linkedTargets(plan).get("lint")).toBeUndefined();
  });
});

describe("unhandled", () => {
  test.each([
    ["names the kinds a target has nowhere to put", "codex", ["skill", "agent"], ["agent"]],
    ["does not count a kind the target takes as parts", "codex", ["plugin", "skill"], []],
    ["is empty for a target that handles them all", "claude", ["plugin", "skill", "agent"], []],
    ["is empty for a target it has never heard of", "nope", ["skill"], []],
  ] as const)("%s", (name, target, kinds, expected) => {
    const table = name.startsWith("names") ? noCodexAgents : targetTable;
    expect(unhandled(table, target, kinds)).toEqual(expected);
  });
});

describe("destroys", () => {
  test("is false for a plan that only adds", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [{ kind: "stage", name: "a", source: "kit", path: "skills/lint", to: "/t" }],
    };
    expect(destroys(plan)).toBe(false);
  });

  test("is true as soon as a link is taken away", () => {
    const plan: Plan = { ...emptyPlan(), actions: [{ kind: "unlink", name: "a", to: "/t" }] };
    expect(destroys(plan)).toBe(true);
  });
});

describe("equivalent", () => {
  const none = { select: [], targets: [], scope: "project", copy: false } as const;
  test.each([
    [
      "the selection and targets",
      "add",
      "acme/kit",
      { ...none, select: ["lint", "review"], targets: ["codex", "claude-code"] },
      "aireg add acme/kit -s lint -s review --for claude-code,codex -y",
    ],
    [
      "-g for the user scope",
      "add",
      "acme/kit",
      { ...none, scope: "user" },
      "aireg add acme/kit -g -y",
    ],
    ["--copy", "add", "acme/kit", { ...none, copy: true }, "aireg add acme/kit --copy -y"],
    [
      "no source for a command that takes none",
      "remove",
      undefined,
      { ...none, select: ["lint"] },
      "aireg remove -s lint -y",
    ],
  ] as const)("repeats an interactive run with %s", (_, command, source, options, expected) => {
    expect(equivalent(command, source, options)).toBe(expected);
  });
});

class FakeInput extends PassThrough {
  isTTY = false;
  setRawMode(): this {
    return this;
  }
}

describe("confirmPlan", () => {
  const ENTER = "\r";
  const edited: Plan = {
    ...emptyPlan(),
    actions: [{ kind: "unlink", name: "a", to: "/t", edited: true }],
  };

  async function answer(
    plan: Plan,
    keys: string[],
    context: PlanContext = {},
  ): Promise<{ proceed: boolean; shown: string }> {
    const input = new FakeInput();
    const frames: string[] = [];
    const io = {
      input: input as unknown as NodeJS.ReadStream,
      output: { write: (chunk: string) => frames.push(chunk), columns: 80, rows: 40 },
    };
    const printer = new Printer({ err: { write: () => true, isTTY: false }, env: {} });
    const run = confirmPlan({ io, printer, blocked: undefined }, plan, context);
    for (const key of keys) {
      // Keys have to arrive after the prompt has subscribed to them.
      await new Promise((resolve) => setImmediate(resolve));
      input.write(key);
    }
    return { proceed: await run, shown: frames.join("") };
  }

  test("names the tools each artifact reaches, and what a tool skips", async () => {
    const row = (kind: "skill" | "agent") =>
      ({ kind, version: "0.1.0", links: [] }) as unknown as LockArtifact;
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "stage", name: "pr-review", source: "acme", path: "p", to: "/s1" },
        { kind: "stage", name: "reviewer", source: "acme", path: "r", to: "/s2" },
        {
          kind: "link",
          name: "pr-review",
          target: "universal",
          from: "/f",
          to: "/t1",
          copy: false,
        },
        {
          kind: "link",
          name: "pr-review",
          target: "claude-code",
          from: "/f",
          to: "/t2",
          copy: false,
        },
        {
          kind: "link",
          name: "reviewer",
          target: "claude-code",
          from: "/f",
          to: "/t3",
          copy: false,
        },
        {
          kind: "record",
          lock: {
            ...emptyLock(),
            artifacts: { "pr-review": row("skill"), reviewer: row("agent") },
          },
        },
      ],
    };
    const { shown } = await answer(plan, [ENTER], {
      targets: ["claude-code", "codex"],
      targetTable: noCodexAgents,
    });
    expect(shown).toMatch(/artifact +version +targets\n/);
    expect(shown).toMatch(/pr-review +0\.1\.0 +Claude Code, Codex/);
    expect(shown).toMatch(/reviewer +0\.1\.0 +Claude Code\n/);
    expect(shown).not.toContain("universal,claude-code");
    expect(shown).toContain("Codex skips reviewer: it does not load agents.");
    expect(shown).toContain("Install 2 artifacts?");
    expect(shown).not.toContain("Proceed?");
  });

  test("places a plugin's members where the lock records them", async () => {
    const row = (kind: "skill" | "agent", targets: string[]) =>
      ({
        kind,
        version: "0.1.0",
        links: targets.map((target) => ({ target, path: "p", mode: "symlink" })),
      }) as unknown as LockArtifact;
    // One link per plugin, named for its first member.
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "stage", name: "pr-review", source: "acme", path: "p", to: "/s1" },
        { kind: "stage", name: "reviewer", source: "acme", path: "r", to: "/s2" },
        {
          kind: "link",
          name: "pr-review",
          target: "claude-code",
          from: "/f",
          to: "/t1",
          copy: false,
        },
        { kind: "link", name: "pr-review", target: "codex", from: "/f", to: "/t2", copy: false },
        {
          kind: "record",
          lock: {
            ...emptyLock(),
            artifacts: {
              "pr-review": row("skill", ["claude-code", "codex"]),
              reviewer: row("agent", ["claude-code"]),
            },
          },
        },
      ],
    };
    const { shown } = await answer(plan, [ENTER], {
      targets: ["claude-code", "codex"],
      targetTable: noCodexAgents,
    });
    expect(shown).toMatch(/reviewer +0\.1\.0 +Claude Code\n/);
    expect(shown).toContain("Codex skips reviewer: it does not load agents.");
  });

  test("starts on No when the plan deletes local edits", async () => {
    const { proceed, shown } = await answer(edited, [ENTER]);
    expect(proceed).toBe(false);
    expect(shown).toContain("has local edits");
    expect(shown).toContain("Remove 1 artifact?");
  });

  test("asks nothing when nothing on disk would change", async () => {
    const plan: Plan = { ...emptyPlan(), actions: [{ kind: "record", lock: emptyLock() }] };
    const { proceed, shown } = await answer(plan, []);
    expect(proceed).toBe(true);
    expect(shown).toBe("");
  });

  test("asks an update by everything it changes", async () => {
    const { shown } = await answer(edited, [ENTER], { verb: "Update" });
    expect(shown).toContain("Update 1 artifact?");
  });
});

describe("chooseTargets", () => {
  const item = (kind: "skill" | "agent", name: string): Selected => ({
    name,
    kind,
    source: "acme",
    path: `engineering/${kind}s/${name}`,
    id: name,
    upstreamName: name,
    contentId: undefined,
    version: undefined,
    contents: [],
    group: "engineering",
  });
  const BOTH = [item("skill", "pr-review"), item("agent", "reviewer")];
  // Google Antigravity sorts first.
  const TO_CLAUDE = [KEY.down];

  async function pick(
    preselected: string[],
    keys: string[],
    items: Selected[] = BOTH,
    scope: Scope = "project",
    tools = targetTable,
    wrapped = false,
  ) {
    const term = terminal(40, 100);
    const printer = new Printer({ err: { write: () => true, isTTY: false }, env: {} });
    const run = chooseTargets(
      { io: term.io, printer, blocked: undefined },
      tools,
      roots(scope, "/w"),
      preselected,
      items,
      wrapped,
    );
    await term.press(...keys);
    const shown = term.screen().join("\n");
    await term.press(KEY.enter);
    return { picked: await run, shown };
  }

  test("offers the tools, not the folder they share", async () => {
    const { picked, shown } = await pick([], []);
    expect(shown).toContain("Codex");
    expect(shown).not.toContain(".agents folder");
    expect(picked).toEqual(["claude-code", "codex"]);
  });

  test("shows where the highlighted tool loads what was picked, and nothing on other rows", async () => {
    const { shown } = await pick([], TO_CLAUDE);
    expect(shown).toMatch(/Claude Code\s+\.claude[\\/]skills, \.claude[\\/]agents/);
    expect(shown).not.toMatch(/Codex\s+\.agents/);
    expect(shown).not.toContain("Found");
  });

  test("follows the cursor: Codex reads skills from .agents, Cursor from .agents and .claude", async () => {
    expect((await pick([], [...TO_CLAUDE, KEY.down])).shown).toMatch(
      /Codex\s+\.agents[\\/]skills, \.codex[\\/]agents$/m,
    );
    expect((await pick([], [...TO_CLAUDE, KEY.down, KEY.down])).shown).toMatch(
      /Cursor\s+\.agents[\\/]skills, \.claude[\\/]agents$/m,
    );
  });

  test("leaves a tool that loads none of it unpicked, with a dash", async () => {
    const agent = [item("agent", "reviewer")];
    const { picked, shown } = await pick(
      [],
      [...TO_CLAUDE, KEY.down],
      agent,
      "project",
      noCodexAgents,
    );
    expect(shown).toMatch(/Codex\s+-$/m);
    expect(picked).toEqual(["claude-code"]);
  });

  test("shows a user scope's folders under ~, never as absolute paths", async () => {
    const tools = resolveTargets({ HOME: homedir() });
    const { shown } = await pick([], TO_CLAUDE, BOTH, "user", tools);
    expect(shown).toContain("~/.claude/skills, ~/.claude/agents");
    expect(shown).not.toContain(homedir());
  });

  test("shows the plugin folder for a source that installs its namespaces as plugins", async () => {
    const tools = resolveTargets({ HOME: homedir() });
    const { shown } = await pick([], TO_CLAUDE, BOTH, "user", tools, true);
    expect(shown).toContain("~/.claude/skills/engineering");
  });

  test("keeps a shared folder the manifest already names", async () => {
    const { picked } = await pick(["universal", "claude-code"], []);
    expect(picked).toEqual(["claude-code", "universal"]);
  });
});
