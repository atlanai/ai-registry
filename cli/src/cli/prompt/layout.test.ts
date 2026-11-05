import { describe, expect, test } from "vitest";
import { fitLines, wrapRows } from "./layout.ts";

describe("fitLines", () => {
  test.each<[string, string | undefined, number, number, string[]]>([
    ["pads to the requested height", "one", 20, 3, ["one", "", ""]],
    ["pads nothing to blank lines", undefined, 20, 2, ["", ""]],
    ["returns no lines for no height", "one", 20, 0, []],
    ["breaks on a space that fits", "alpha beta gamma", 11, 2, ["alpha beta", "gamma"]],
    [
      "keeps the last cell free on all but the final line",
      "alpha beta gamma",
      10,
      2,
      ["alpha", "beta gamma"],
    ],
    [
      "marks text it could not fit",
      "alpha beta gamma delta epsilon",
      11,
      2,
      ["alpha beta", "gamma…"],
    ],
    ["marks a cut on a single line", "ab cde", 5, 1, ["ab…"]],
    ["splits a word longer than the line", "abcdef gh", 5, 2, ["abcde", "f gh"]],
    ["cuts a long word that will not fit", "abcdefghijk", 5, 2, ["abcde", "fghi…"]],
    [
      "measures wide characters in cells",
      "日本語の説明文です。とても長い",
      10,
      2,
      ["日本語の説", "明文です…"],
    ],
    ["keeps a joined emoji whole", "family 👨‍👩‍👧 here", 11, 1, ["family 👨‍👩‍👧…"]],
    ["collapses newlines into one paragraph", "a\n\n  b", 20, 1, ["a b"]],
  ])("%s", (_, text, width, count, expected) => {
    expect(fitLines(text, width, count)).toEqual(expected);
  });
});

describe("wrapRows", () => {
  test.each<[string, string, number, string[]]>([
    ["leaves a line that fits", "hello", 80, ["hello"]],
    [
      "breaks at the last cell, as a terminal soft-wraps",
      "x".repeat(85),
      40,
      ["x".repeat(40), "x".repeat(40), "xxxxx"],
    ],
    ["never splits a wide character", "ab日本", 3, ["ab", "日", "本"]],
    ["never splits a joined emoji", "a👨‍👩‍👧b", 3, ["a👨‍👩‍👧", "b"]],
    [
      "ignores styling when measuring",
      `\u001B[2m${"x".repeat(40)}\u001B[0m`,
      40,
      [`\u001B[2m${"x".repeat(40)}\u001B[0m`],
    ],
    [
      "reopens styling on the next row",
      "\u001B[2mabcd\u001B[0m",
      2,
      ["\u001B[2mab\u001B[0m", "\u001B[2mcd\u001B[0m"],
    ],
  ])("%s", (_, line, columns, expected) => {
    expect(wrapRows(line, columns)).toEqual(expected);
  });
});
