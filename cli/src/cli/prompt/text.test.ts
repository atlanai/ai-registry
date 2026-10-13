import { describe, expect, it } from "vitest";
import { Styler } from "#core/output.ts";
import { KEY, terminal } from "#test/kit/fake-terminal.ts";
import { CANCEL } from "./prompt.ts";
import { text } from "./text.ts";

const { up, enter, escape: esc, ctrlC, backspace } = KEY;
const style = new Styler({ isTTY: false }, {});

async function type(initial: string | undefined, keys: string[], hint?: string) {
  const term = terminal();
  const run = text({ message: "Name", style, initial, hint }, term.io);
  await term.press();
  const first = term.screen();
  await term.press(...keys.slice(0, -1));
  const typing = term.screen();
  await term.press(...keys.slice(-1));
  return { value: await run, first, typing, screen: term.screen() };
}

describe("text", () => {
  it("shows the cursor and the suggestion until something is typed, and takes it when nothing is", async () => {
    const { value, first, screen } = await type("newreg", [enter]);
    expect(first).toEqual(["◆  Name  ▌newreg"]);
    expect(value).toBe("newreg");
    expect(screen).toEqual(["◇  Name  newreg"]);
  });

  it("shows the hint under the question until it is answered", async () => {
    const { first, screen } = await type("newreg", [enter], "Press Enter to use newreg.");
    expect(first).toEqual(["◆  Name  ▌newreg", "│  Press Enter to use newreg."]);
    expect(screen).toEqual(["◇  Name  newreg"]);
  });

  it("answers with what was typed, trimmed", async () => {
    const { value, typing, screen } = await type("newreg", [" ab ", "c", backspace, enter]);
    expect(typing).toEqual(["◆  Name   ab ▌"]);
    expect(value).toBe("ab");
    expect(screen).toEqual(["◇  Name   ab"]);
  });

  it("goes back to the suggestion when everything typed is erased", async () => {
    const { value, typing } = await type("x", ["a", backspace, backspace, enter]);
    expect(typing).toEqual(["◆  Name  ▌x"]);
    expect(value).toBe("x");
  });

  it("answers empty when there is nothing to suggest", async () => {
    expect((await type(undefined, [enter])).value).toBe("");
  });

  it("erases a whole character, however many code units it takes", async () => {
    expect((await type(undefined, ["日本", "👍", backspace, enter])).value).toBe("日本");
  });

  it("ignores arrows and control keys", async () => {
    expect((await type(undefined, ["ab", up, "\t", "\u0015", "\u001B[3~", "z", enter])).value).toBe(
      "abz",
    );
  });

  it("cancels on escape and on ctrl+c", async () => {
    const escaped = await type("x", ["q", esc]);
    expect(escaped.value).toBe(CANCEL);
    expect(escaped.screen).toEqual(["■  Name  canceled"]);
    expect((await type("x", [ctrlC])).value).toBe(CANCEL);
  });
});
