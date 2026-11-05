import { describe, expect, test } from "vitest";
import {
  ago,
  bar,
  bytes,
  cut,
  day,
  displayWidth,
  interval,
  pad,
  truncate,
  truncateStart,
} from "./format.ts";

describe("bytes", () => {
  test("keeps whole bytes whole and scales past a kilobyte", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1023)).toBe("1023 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(3_074_365_066)).toBe("2.9 GB");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  test("names the largest unit that still reads as a count", () => {
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 4 * 60_000, now)).toBe("4m ago");
    expect(ago(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(ago(now - 7 * 86_400_000, now)).toBe("7d ago");
  });

  test("reads an instant still to come as a wait", () => {
    expect(ago(now + 7 * 86_400_000, now)).toBe("in 7d");
  });
});

describe("bar", () => {
  test("never fills while work is outstanding", () => {
    expect(bar(999, 1000, 10)).toBe("▓▓▓▓▓▓▓▓▓░");
    expect(bar(1000, 1000, 10)).toBe("▓".repeat(10));
    expect(bar(0, 1000, 10)).toBe("░".repeat(10));
    expect(bar(0, 0, 4)).toBe("░".repeat(4));
  });
});

describe("day", () => {
  const now = Date.parse("2026-09-21T12:00:00");
  test("names the recent days and dates the rest", () => {
    expect(day(now, now)).toBe("Today");
    expect(day(now - 86_400_000, now)).toBe("Yesterday");
    expect(day(now - 5 * 86_400_000, now)).not.toBe("Yesterday");
  });
});

describe("displayWidth", () => {
  // A frame glyph counted as two would leave every redraw a row short.
  test.each<[string, string, number]>([
    ["styling", "\u001B[32mok\u001B[0m", 2],
    ["wide glyphs", "日本한국어", 10],
    ["an emoji", "👍", 2],
    ["a joined emoji", "👨‍👩‍👧", 2],
    ["a flag", "🇯🇵", 2],
    ["a combining mark", "e\u0301", 1],
    ["the frame glyphs", "│❯●◐◆◇■▸▾├╴╰╴↳·↑↓←→", 19],
  ])("counts %s in terminal cells", (_, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });
});

describe("cut", () => {
  test("keeps the longest prefix that fits, never splitting a wide glyph or an emoji", () => {
    expect(cut("abc", 5)).toBe("abc");
    expect(cut("日本語", 3)).toBe("日");
    expect(cut("👍x", 1)).toBe("");
    expect(cut("👨‍👩‍👧z", 2)).toBe("👨‍👩‍👧");
    expect(cut("e\u0301x", 1)).toBe("e\u0301");
  });

  test("keeps the styling it passes", () => {
    expect(cut("\u001B[31mred\u001B[0m", 2)).toBe("\u001B[31mre");
  });
});

describe("truncate", () => {
  test("marks the cut, inside the width", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("日本語", 4)).toBe("日…");
    expect(truncate("abcdef", 1)).toBe("a");
    expect(truncate("abcdef", 0)).toBe("");
  });
});

describe("truncateStart", () => {
  test("keeps the tail, which is what identifies a long path", () => {
    expect(truncateStart("projects/a/b/history.jsonl", 12)).toBe("…story.jsonl");
    expect(truncateStart("short", 12)).toBe("short");
  });

  test("stays inside the width when the tail is wide", () => {
    expect(truncateStart("日本語日本語", 4)).toBe("…語");
    expect(truncateStart("abc👨‍👩‍👧", 3)).toBe("…👨‍👩‍👧");
  });
});

describe("pad", () => {
  test("fills to the width in cells, cutting what is longer", () => {
    expect(pad("ab", 4)).toBe("ab  ");
    expect(pad("日本", 5)).toBe("日本 ");
    expect(pad("abcdef", 4)).toBe("abc…");
  });
});

describe("interval", () => {
  test("reads in the largest whole unit", () => {
    expect(interval(900)).toBe("every 15m");
    expect(interval(7200)).toBe("every 2h");
    expect(interval(45)).toBe("every 45s");
  });
});
