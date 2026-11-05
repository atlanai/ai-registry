import { describe, expect, test } from "vitest";
import { Styler } from "#core/term/printer.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import { CANCEL } from "./model.ts";
import { confirm, type SelectOptions, select } from "./select.ts";

const { up, down, enter, space, escape: esc, ctrlC } = KEY;
const style = new Styler({ isTTY: false }, {});

const scope: Omit<SelectOptions<string>, "style"> = {
  message: "Installation scope",
  options: [
    {
      value: "project",
      label: "Project",
      hint: "shared with the repo · ./.registry/",
    },
    { value: "user", label: "User", hint: "all your projects · ~/.registry/" },
  ],
};

async function pick<T>(options: Omit<SelectOptions<T>, "style">, keys: string[]) {
  const term = terminal();
  const run = select({ ...options, style }, term.io);
  await term.press();
  const frame = term.screen();
  await term.press(...keys);
  return { value: await run, frame, screen: term.screen() };
}

describe("select", () => {
  test("completes and writes its answer when output is redirected", async () => {
    const term = terminal();
    const run = select(
      { ...scope, style },
      { ...term.io, output: { ...term.io.output, isTTY: false } },
    );
    await term.press(enter);
    expect(await run).toBe("project");
    expect(term.screen()).toEqual(["◇  Installation scope  Project"]);
  });

  test("draws its options with hints, the cursor on the first", async () => {
    const { frame } = await pick(scope, [enter]);
    expect(frame).toEqual([
      "◆  Installation scope",
      "│",
      "│  ● Project  shared with the repo · ./.registry/",
      "│  ○ User     all your projects · ~/.registry/",
      "│",
      "│  ↑↓ move · enter confirm · esc cancel",
      "└",
    ]);
  });

  test("wraps at either end, since the cursor is the answer", async () => {
    expect((await pick(scope, [up, enter])).value).toBe("user");
    expect((await pick(scope, [down, down, enter])).value).toBe("project");
  });

  test("collapses to the answer", async () => {
    expect((await pick(scope, [down, enter])).screen).toEqual(["◇  Installation scope  User"]);
  });

  test("collapses to an option's shorter answer when it has one", async () => {
    const method = {
      message: "How should they be installed?",
      options: [
        { value: "link", label: "Symlink (recommended)", answer: "Symlink" },
        { value: "copy", label: "Copy" },
      ],
    };
    expect((await pick(method, [enter])).screen).toEqual([
      "◇  How should they be installed?  Symlink",
    ]);
  });

  test("starts on the initial value, or the first when it matches nothing", async () => {
    expect((await pick({ ...scope, initial: "user" }, [enter])).value).toBe("user");
    expect((await pick({ ...scope, initial: "nowhere" }, [enter])).value).toBe("project");
  });

  test("ignores space and other letters", async () => {
    expect((await pick(scope, [space, "x", down, enter])).value).toBe("user");
  });

  test("cancels on escape and on ctrl+c", async () => {
    const escaped = await pick(scope, [esc]);
    expect(escaped.value).toBe(CANCEL);
    expect(escaped.screen).toEqual(["■  Installation scope  canceled"]);
    expect((await pick(scope, [ctrlC])).value).toBe(CANCEL);
  });

  test("draws registry text in its options as inert text, answering with the value as it is", async () => {
    const hostile = "kit\u001B]8;;https://example.test/\u0007x\u001B]8;;\u0007\u001B[8mhidden";
    const term = terminal();
    const run = select(
      {
        message: "Pick",
        style: new Styler({ isTTY: false }, {}, "always"),
        options: [{ value: hostile, label: hostile, hint: `at ${hostile}` }],
      },
      term.io,
    );
    await term.press(enter);
    expect(await run).toBe(hostile);
    expect(term.written()).not.toContain("\u001B]8;");
    expect(term.written()).not.toContain("\u001B[8m");
    expect(term.written()).toContain("\u001B[32m");
    expect(term.screen()).toEqual(["◇  Pick  kitxhidden"]);
  });

  test("moves to an option by its letter, in either case", async () => {
    const lettered = {
      message: "Pick",
      options: [
        { value: 1, label: "One", key: "o" },
        { value: 2, label: "Two", key: "t" },
      ],
    };
    const { value, frame } = await pick(lettered, ["T", enter]);
    expect(value).toBe(2);
    expect(frame.at(-2)).toBe("│  o/t · ↑↓ choose · enter confirm · esc cancel");
  });
});

describe("confirm", () => {
  async function ask(initial: boolean | undefined, keys: string[]) {
    const term = terminal();
    const run = confirm({ message: "Proceed?", style, initial }, term.io);
    await term.press();
    const frame = term.screen();
    await term.press(...keys);
    return { value: await run, frame, screen: term.screen() };
  }

  test("is yes by default, with y and n as keys", async () => {
    const { value, frame, screen } = await ask(undefined, [enter]);
    expect(value).toBe(true);
    expect(frame).toEqual([
      "◆  Proceed?",
      "│",
      "│  ● Yes",
      "│  ○ No",
      "│",
      "│  y/n · ↑↓ choose · enter confirm · esc cancel",
      "└",
    ]);
    expect(screen).toEqual(["◇  Proceed?  Yes"]);
  });

  test("starts on No when asked to", async () => {
    expect((await ask(false, [enter])).value).toBe(false);
  });

  test("takes n and y before enter", async () => {
    expect((await ask(true, ["n", enter])).value).toBe(false);
    expect((await ask(false, ["n", "y", enter])).value).toBe(true);
  });
});
