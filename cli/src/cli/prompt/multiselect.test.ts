import { describe, expect, it } from "vitest";
import { Styler } from "#core/output.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import { type Choice, type MultiselectOptions, multiselect } from "./multiselect.ts";
import { CANCEL } from "./prompt.ts";

const { up, down, left, right, enter, space, escape: esc, ctrlC } = KEY;

const choices: Choice<string>[] = [
  { value: "api-design", label: "api-design", hint: "skill", group: "acme-api" },
  { value: "api-review", label: "api-review", hint: "skill", group: "acme-api" },
  { value: "doctor", label: "doctor", hint: "command", group: "acme-core" },
  { value: "loose", label: "loose", hint: "agent" },
];

const nested: Choice<string>[] = [
  { value: "debug", label: "debug", hint: "skill", group: "acme-core", section: "skills" },
  { value: "ship", label: "ship", hint: "skill", group: "acme-core", section: "skills" },
  { value: "adr", label: "adr", hint: "command", group: "acme-core", section: "commands" },
];

const tree: Choice<string>[] = [
  {
    value: "checkout-flow",
    label: "checkout-flow",
    group: "engineering",
    section: "skills",
    detail: "Walks a cart through checkout.",
  },
  {
    value: "payment-errors",
    label: "payment-errors",
    group: "engineering",
    section: "skills",
    detail:
      "Turns a payment error into the message a shopper sees. Use when handling a declined card, an expired card or a failed address check.",
  },
  { value: "reviewer", label: "reviewer", group: "engineering", section: "agents" },
  { value: "brand", label: "brand", group: "frontend", section: "skills" },
];

const style = new Styler({ isTTY: false }, {});

type Options = Omit<MultiselectOptions<string>, "style" | "message"> & { message?: string };

async function answer(options: Options, keys: string[], rows = 40, columns = 80) {
  const term = terminal(rows, columns);
  const run = multiselect({ message: "Pick", style, ...options }, term.io);
  await term.press(...keys);
  return { value: await run, screen: term.screen(), term };
}

/** The frame drawn after `keys`, before the prompt is left with escape. */
async function frameAfter(options: Options, keys: string[], rows = 40, columns = 80) {
  const term = terminal(rows, columns);
  const run = multiselect({ message: "Pick", style, ...options }, term.io);
  await term.press(...keys);
  const frame = term.screen();
  await term.press(esc);
  await run;
  return frame;
}

describe("multiselect keys", () => {
  it("returns what the cursor was on when space was pressed", async () => {
    expect((await answer({ choices }, [down, space, enter])).value).toEqual(["api-review"]);
  });

  it("stops at either end rather than wrapping", async () => {
    const { value } = await answer({ choices }, [up, space, down, down, down, down, space, enter]);
    expect(value).toEqual(["api-design", "loose"]);
  });

  it("folds from a leaf onto its heading, which space then takes", async () => {
    const { value } = await answer({ choices, groups: true }, [down, left, space, enter]);
    expect(value).toEqual(["api-design", "api-review"]);
  });

  it("unfolds a folded heading again", async () => {
    const { value } = await answer({ choices, groups: true }, [left, right, down, space, enter]);
    expect(value).toEqual(["api-design"]);
  });

  it("refuses to submit nothing when a selection is required", async () => {
    const { value } = await answer({ choices, required: true }, [enter, space, enter]);
    expect(value).toEqual(["api-design"]);
  });

  it("takes every row with a, and clears them with a second a", async () => {
    expect((await answer({ choices, selectAll: true }, ["a", enter])).value).toEqual(
      choices.map((choice) => choice.value),
    );
    const { value } = await answer({ choices, selectAll: true }, ["a", "a", space, enter]);
    expect(value).toEqual(["api-design"]);
  });

  it("lists Select all, with no count of its own, and a divider above the tree, group hints in a column, and space on it takes all", async () => {
    const groupHints = new Map([
      ["engineering", "2 skills, 1 agent"],
      ["frontend", "1 skill"],
    ]);
    const options = { choices: tree, groups: true, collapsed: true, selectAll: true, groupHints };
    const opened = await frameAfter(options, []);
    expect(opened.slice(2, 6)).toEqual([
      "│   ○ Select all",
      "│   ────────────────────────",
      "│ ❯ ▸ ○ engineering  2 skills, 1 agent",
      "│   ▸ ○ frontend     1 skill",
    ]);
    const term = terminal(40, 80);
    const run = multiselect({ message: "Pick", style, ...options }, term.io);
    await term.press(space, up);
    expect(term.screen()[2]).toBe("│ ❯ ◐ Select all");
    await term.press(space, enter);
    expect(await run).toEqual(tree.map((choice) => choice.value));
  });

  it("marks Select all partial when only part of one heading is picked", async () => {
    const options = { choices: tree, groups: true, selectAll: true };
    const frame = await frameAfter(options, [down, space]);
    expect(frame[2]).toBe("│   ◐ Select all");
  });

  it("ignores other letters, and a where select-all is off", async () => {
    expect((await answer({ choices }, ["d", "a", space, enter])).value).toEqual(["api-design"]);
  });

  it("reads keys that arrive in one burst one by one", async () => {
    const { value } = await answer({ choices }, [down + space + down + space + enter]);
    expect(value).toEqual(["api-review", "doctor"]);
  });

  it("cancels on escape and on ctrl+c", async () => {
    expect((await answer({ choices }, [space, esc])).value).toBe(CANCEL);
    const { value, screen } = await answer({ choices }, [down, ctrlC]);
    expect(value).toBe(CANCEL);
    expect(screen).toEqual(["■  Pick  canceled"]);
  });

  it("answers at once, drawing nothing, when there is nothing to pick", async () => {
    const term = terminal();
    expect(await multiselect({ message: "Pick", style, choices: [] }, term.io)).toBe(CANCEL);
    expect(term.written()).toBe("");
  });
});

describe("multiselect groups that stand for a plugin", () => {
  const values = new Map([
    ["acme-api", "acme-api"],
    ["acme-core", "acme-core"],
  ]);

  it("opens as one row per group when collapsed, and space takes the group", async () => {
    const { value } = await answer(
      { choices, groups: true, groupValues: values, collapsed: true },
      [space, enter],
    );
    expect(value).toEqual(["acme-api"]);
  });

  it("takes the plugin in place of the leaves already picked under it", async () => {
    const { value } = await answer({ choices, groups: true, groupValues: values }, [
      down,
      space,
      up,
      space,
      enter,
    ]);
    expect(value).toEqual(["acme-api"]);
  });

  it("leaves a leaf out of a whole plugin by picking the rest by name", async () => {
    const { value } = await answer({ choices, groups: true, groupValues: values }, [
      space,
      down,
      space,
      enter,
    ]);
    expect(value).toEqual(["api-review"]);
  });

  it("shows a whole plugin's leaves as picked, and a partial one as some", async () => {
    const whole = await frameAfter({ choices, groups: true, groupValues: values }, [space]);
    expect(whole.join("\n")).toMatch(/● api-design/);
    const part = await frameAfter({ choices, groups: true, groupValues: values, detail: true }, [
      space,
      down,
      space,
      up,
    ]);
    expect(part.join("\n")).toMatch(/◐ acme-api/);
    expect(part.join("\n")).toContain("1 of 2 in acme-api. New ones won't be added.");
  });

  it("leaves a whole section out of a whole plugin, picking the other kinds by name", async () => {
    const core = new Map([["acme-core", "acme-core"]]);
    const { value } = await answer({ choices: nested, groups: true, groupValues: core }, [
      space,
      down,
      space,
      enter,
    ]);
    expect(value).toEqual(["adr"]);
  });

  it("clears a section that is already full", async () => {
    const { value } = await answer({ choices: nested, groups: true }, [down, space, space, enter]);
    expect(value).toEqual([]);
  });
});

describe("the picker frame", () => {
  it("counts the selection beside the title", async () => {
    const lines = await frameAfter({ choices, selectAll: true }, [space]);
    expect(lines[0]).toBe("◆  Pick  1 of 4 selected");
  });

  it("counts every leaf under a heading picked whole", async () => {
    const values = new Map([["engineering", "engineering/"]]);
    const lines = await frameAfter(
      { choices: tree, groups: true, groupValues: values, collapsed: true },
      [space],
    );
    expect(lines[0]).toBe("◆  Pick  3 of 4 selected");
    expect(lines[2]).toBe("│ ❯ ▸ ● engineering  (3)");
  });

  it("draws leaves on a rounded tree under open headings", async () => {
    const lines = await frameAfter({ choices: tree, groups: true, maxVisible: 20 }, [
      down,
      down,
      down,
    ]);
    expect(lines.slice(2, 11)).toEqual([
      "│   ▾ ○ engineering  (3)",
      "│     ▾ ○ skills (2)",
      "│       ├╴○ checkout-flow",
      "│ ❯     ╰╴○ payment-errors",
      "│     ▾ ○ agents (1)",
      "│       ╰╴○ reviewer",
      "│   ▾ ○ frontend     (1)",
      "│     ▾ ○ skills (1)",
      "│       ╰╴○ brand",
    ]);
  });

  it("shows a hint beside a leaf only where no section names its kind", async () => {
    const lines = await frameAfter({ choices, groups: true }, []);
    expect(lines).toContain("│     ├╴○ api-design skill");
    expect(lines).toContain("│   ○ loose agent");
  });

  it("shows the highlighted row's description under an arrow, at a fixed height", async () => {
    const options = { choices: tree, groups: true, detail: true };
    const lines = await frameAfter(options, [down, down, down], 40, 64);
    const at = lines.findIndex((line) => line.startsWith("│  ↳ "));
    expect(lines[at]).toBe("│  ↳ Turns a payment error into the message a shopper sees.");
    expect(lines[at + 1]).toBe("│    Use when handling a declined card, an expired card or a…");
    const short = await frameAfter(options, [down, down], 40, 64);
    expect(short.length).toBe(lines.length);
    expect(short[at]).toBe("│  ↳ Walks a cart through checkout.");
    expect(short[at + 1]).toBe("│");
  });

  it("describes a heading by what it holds", async () => {
    const lines = await frameAfter({ choices: tree, groups: true, detail: true }, [down]);
    expect(lines).toContain("│  ↳ Every skills artifact in engineering: 2 in all.");
    const top = await frameAfter({ choices: tree, groups: true, detail: true }, []);
    expect(top).toContain("│  ↳ Everything in engineering: 3 artifacts.");
  });

  it("ends with the keys that apply, just above the corner", async () => {
    const grouped = await frameAfter({ choices, groups: true, selectAll: true }, []);
    expect(grouped.slice(-3)).toEqual([
      "│",
      "│  ↑↓ move · ←→ fold · space pick · a all · enter next · esc cancel",
      "└",
    ]);
    const flat = await frameAfter({ choices }, []);
    expect(flat.slice(-2)).toEqual(["│  ↑↓ move · space pick · enter next · esc cancel", "└"]);
  });

  it.each<[string, Options, string[], string]>([
    ["the picked labels", { choices }, [space, down, space, enter], "api-design, api-review"],
    [
      "a group picked whole after the leaves picked alone",
      { choices, groups: true, groupValues: new Map([["acme-core", "acme-core"]]) },
      [down, down, down, space, up, space, enter],
      "api-review, acme-core",
    ],
    ["nothing selected", { choices }, [enter], "nothing selected"],
  ])("collapses to %s, erasing the list it drew", async (_, options, keys, picked) => {
    expect((await answer(options, keys)).screen).toEqual([`◇  Pick  ${picked}`]);
  });
});

describe("the picker on a short or narrow terminal", () => {
  const options = { choices: tree, groups: true, detail: true, maxVisible: 20 };

  it("windows the list around the cursor and says what is off screen", async () => {
    const lines = await frameAfter(options, [down, down, down], 14);
    expect(lines.length).toBeLessThanOrEqual(13);
    expect(lines.slice(2, 7)).toEqual([
      "│       ├╴○ checkout-flow",
      "│ ❯     ╰╴○ payment-errors",
      "│     ▾ ○ agents (1)",
      "│       ╰╴○ reviewer",
      "│  2 above, 3 below",
    ]);
    expect(lines.some((line) => line.startsWith("│  ↳ "))).toBe(true);
  });

  it("drops the description only when even three rows of list would not fit", async () => {
    const twelve = await frameAfter(options, [down, down, down], 12);
    expect(twelve.length).toBeLessThanOrEqual(11);
    expect(twelve.some((line) => line.startsWith("│  ↳ "))).toBe(false);
    expect(twelve.slice(2, 8)).toEqual([
      "│       ├╴○ checkout-flow",
      "│ ❯     ╰╴○ payment-errors",
      "│     ▾ ○ agents (1)",
      "│       ╰╴○ reviewer",
      "│   ▾ ○ frontend     (1)",
      "│  2 above, 2 below",
    ]);

    const nine = await frameAfter(options, [down, down, down], 9);
    expect(nine).toEqual([
      "◆  Pick  0 of 4 selected",
      "│",
      "│ ❯     ╰╴○ payment-errors",
      "│     ▾ ○ agents (1)",
      "│  3 above, 4 below",
      "│",
      "│  ↑↓ move · ←→ fold · space pick · enter next · esc cancel",
      "└",
    ]);
  });

  it("counts a wrapped key line when fitting, and wraps where the terminal would", async () => {
    const lines = await frameAfter({ ...options, selectAll: true }, [], 13, 40);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.slice(-3)).toEqual([
      "│  ↑↓ move · ←→ fold · space pick · a al",
      "l · enter next · esc cancel",
      "└",
    ]);
  });
});

describe("sequential prompts", () => {
  it("hand the terminal back after each answer", async () => {
    const term = terminal();
    const first = multiselect({ message: "One", style, choices }, term.io);
    await term.press(space, enter);
    expect(await first).toEqual(["api-design"]);
    expect(term.input.listenerCount("readable")).toBe(0);
    expect(term.input.raw).toBe(false);

    const second = multiselect({ message: "Two", style, choices }, term.io);
    await term.press(down, space, enter);
    expect(await second).toEqual(["api-review"]);
    expect(term.screen()).toEqual(["◇  One  api-design", "◇  Two  api-review"]);
    expect(term.input.raw).toBe(false);
  });
});

describe("multiselect focus hint", () => {
  const tools: Choice<string>[] = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ];
  const focusHint = (value: string, picked: ReadonlySet<string>) =>
    `${value} with ${[...picked].join("+") || "none"}`;

  it("shows on the highlighted row alone, lined up after the longest name", async () => {
    const frame = await frameAfter({ choices: tools, focusHint }, [down]);
    expect(frame).toContain("│   ○ Claude Code");
    expect(frame).toContain("│ ❯ ○ Codex        codex with none");
  });

  it("follows what is picked so far", async () => {
    const frame = await frameAfter({ choices: tools, focusHint }, [space, down]);
    expect(frame.join("\n")).toContain("codex with claude");
  });
});
