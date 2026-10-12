import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolveHarnesses } from "#core/harness/index.ts";
import { Printer } from "#core/output.ts";
import { emptyPlan, type Plan } from "#core/plan/model.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import {
  chooseTargets,
  confirmPlan,
  destroys,
  equivalent,
  linkedTargets,
  methodIsMeaningful,
  unhandled,
  unreached,
} from "./flow.ts";

const harnesses = resolveHarnesses({ HOME: "/home/dev" });

describe("methodIsMeaningful", () => {
  // Codex places a plugin as its parts; Cursor has nowhere for an agent.
  it.each([
    ["one harness, where a link and a copy land identically", ["claude"], undefined, false],
    ["two harness roots that would each receive it", ["claude", "codex"], undefined, true],
    ["nothing selected", [], undefined, false],
    ["only one harness that can place the kind", ["claude"], ["plugin"], false],
    ["a harness that takes a plugin as its parts", ["claude", "codex"], ["plugin"], true],
    [
      "several harnesses that can place the kind",
      ["claude", "codex", "cursor", "agents"],
      ["skill"],
      true,
    ],
    [
      "harnesses that can each place one of the kinds",
      ["claude", "cursor"],
      ["plugin", "agent"],
      true,
    ],
  ] as const)("given %s", (_, ids, kinds, meaningful) => {
    expect(methodIsMeaningful(harnesses, ids, "project", "/w", kinds)).toBe(meaningful);
  });
});

describe("unreached", () => {
  it("names the chosen harnesses no link was made for", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "stage", name: "a", source: "kit", path: "skills/lint", to: "/t" },
        { kind: "link", name: "a", harness: "claude", from: "/f", to: "/t", copy: false },
      ],
    };
    expect(unreached(plan, ["claude", "codex", "agents"])).toEqual(["agents", "codex"]);
  });

  it("is empty when every harness got something", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [{ kind: "link", name: "a", harness: "claude", from: "/f", to: "/t", copy: false }],
    };
    expect(unreached(plan, ["claude"])).toEqual([]);
  });

  it("counts a harness reached through a folder it reads", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [{ kind: "link", name: "a", harness: "agents", from: "/f", to: "/t", copy: false }],
    };
    // Codex reads skills from `.agents`, so a link there reaches it.
    expect(unreached(plan, ["codex", "claude"], harnesses)).toEqual(["claude"]);
  });
});

describe("linkedTargets", () => {
  it("names each harness once, however many members point into it", () => {
    // A plugin is one entry in the plan but one link per member per harness,
    // so the line otherwise repeats each target for every member.
    const plan: Plan = {
      ...emptyPlan(),
      actions: [
        { kind: "link", name: "core", harness: "codex", from: "/f", to: "/t1", copy: false },
        { kind: "link", name: "core", harness: "codex", from: "/f", to: "/t2", copy: false },
        { kind: "link", name: "core", harness: "pi", from: "/f", to: "/t3", copy: false },
      ],
    };

    expect(linkedTargets(plan).get("core")).toEqual(["codex", "pi"]);
  });

  it("has no entry for an artifact that was only staged", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [{ kind: "stage", name: "lint", source: "kit", path: "skills/lint", to: "/t" }],
    };

    expect(linkedTargets(plan).get("lint")).toBeUndefined();
  });
});

describe("unhandled", () => {
  it.each([
    ["names the kinds a harness has nowhere to put", "codex", ["skill", "agent"], ["agent"]],
    ["does not count a kind the harness takes as parts", "codex", ["plugin", "skill"], []],
    ["is empty for a harness that handles them all", "claude", ["plugin", "skill", "agent"], []],
    ["is empty for a harness it has never heard of", "nope", ["skill"], []],
  ] as const)("%s", (_, harness, kinds, expected) => {
    expect(unhandled(harnesses, harness, kinds)).toEqual(expected);
  });
});

describe("destroys", () => {
  it("is false for a plan that only adds", () => {
    const plan: Plan = {
      ...emptyPlan(),
      actions: [{ kind: "stage", name: "a", source: "kit", path: "skills/lint", to: "/t" }],
    };
    expect(destroys(plan)).toBe(false);
  });

  it("is true as soon as a link is taken away", () => {
    const plan: Plan = { ...emptyPlan(), actions: [{ kind: "unlink", name: "a", to: "/t" }] };
    expect(destroys(plan)).toBe(true);
  });
});

describe("equivalent", () => {
  const none = { select: [], targets: [], scope: "project", copy: false } as const;
  it.each([
    [
      "the selection and targets",
      "add",
      "acme/kit",
      { ...none, select: ["lint", "review"], targets: ["codex", "claude"] },
      "aireg add acme/kit -s lint -s review --for claude,codex -y",
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

  async function answer(plan: Plan, keys: string[]): Promise<{ proceed: boolean; shown: string }> {
    const input = new FakeInput();
    const frames: string[] = [];
    const io = {
      input: input as unknown as NodeJS.ReadStream,
      output: { write: (chunk: string) => frames.push(chunk), columns: 80, rows: 40 },
    };
    const printer = new Printer({ err: { write: () => true, isTTY: false }, env: {} });
    const run = confirmPlan({ io, printer, blocked: undefined }, plan);
    for (const key of keys) {
      // Keys have to arrive after the prompt has subscribed to them.
      await new Promise((resolve) => setImmediate(resolve));
      input.write(key);
    }
    return { proceed: await run, shown: frames.join("") };
  }

  it("starts on No when the plan deletes local edits", async () => {
    const { proceed, shown } = await answer(edited, [ENTER]);
    expect(proceed).toBe(false);
    expect(shown).toContain("has local edits");
  });
});

describe("chooseTargets", () => {
  async function pick(preselected: string[], keys: string[]) {
    const term = terminal(40, 100);
    const printer = new Printer({ err: { write: () => true, isTTY: false }, env: {} });
    const run = chooseTargets(
      { io: term.io, printer, blocked: undefined },
      harnesses,
      "project",
      "/w",
      preselected,
    );
    await term.press(...keys);
    const shown = term.screen().join("\n");
    await term.press(KEY.enter);
    return { picked: await run, shown };
  }

  it("offers the tools, not the folder they share", async () => {
    const { picked, shown } = await pick([], []);
    expect(shown).toContain("Codex");
    expect(shown).not.toContain(".agents folder");
    expect(picked).toEqual(["claude", "codex"]);
  });

  it("says where a tool reads a kind from another folder", async () => {
    const { shown } = await pick([], [KEY.down]);
    expect(shown).toContain("Reads skills from .agents.");
  });

  it("keeps a shared folder the manifest already names", async () => {
    const { picked } = await pick(["agents", "claude"], []);
    expect(picked).toEqual(["claude", "agents"]);
  });
});
