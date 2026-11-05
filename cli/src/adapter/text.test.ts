import { describe, expect, test } from "vitest";
import {
  quoted,
  sanitizeBlock,
  sanitizeName,
  sanitizeText,
  stripLeading,
  stripTrailing,
  withoutCredentials,
} from "./text.ts";

describe("sanitizeName", () => {
  test("keeps a name that is already an address", () => {
    expect(sanitizeName("pr-review")).toBe("pr-review");
    expect(sanitizeName("access--01kzrtf9bhe69ssx1xc9hfw2ea")).toBe(
      "access--01kzrtf9bhe69ssx1xc9hfw2ea",
    );
  });

  test("settles in one pass, which is what lets an address be matched by comparison", () => {
    const boundary = `${"x".repeat(63)}-${"y".repeat(10)}`;
    for (const name of [
      boundary,
      `${"x".repeat(63)}.tail`,
      "A--B",
      "..x",
      "-",
      "",
      "  spaced  name  ",
      "日本語",
      `${"a".repeat(300)}`,
    ]) {
      const once = sanitizeName(name);
      expect(sanitizeName(once), `"${name.slice(0, 24)}…" is not settled`).toBe(once);
    }
  });

  test("never ends in a separator, however long the name was", () => {
    expect(sanitizeName(`${"x".repeat(63)}-${"y".repeat(10)}`)).toBe("x".repeat(63));
  });

  test("cuts to the segment length the file spec allows", () => {
    expect(sanitizeName("a".repeat(300))).toBe("a".repeat(64));
  });
});

describe("withoutCredentials", () => {
  test("strips userinfo a user typed into a source URL", () => {
    const token = `ghp_${"0".repeat(36)}`;
    expect(withoutCredentials(`https://user:${token}@github.com/a/b`)).toBe(
      "https://<redacted>@github.com/a/b",
    );
  });

  test("strips a bare username too", () => {
    expect(withoutCredentials("https://token@example.com/x")).toBe(
      "https://<redacted>@example.com/x",
    );
  });

  test("leaves a clean URL alone", () => {
    expect(withoutCredentials("https://github.com/a/b")).toBe("https://github.com/a/b");
  });

  test("leaves shorthand and paths alone", () => {
    expect(withoutCredentials("owner/repo")).toBe("owner/repo");
    expect(withoutCredentials("./local/dir")).toBe("./local/dir");
  });

  test("does not mistake an scp-style remote for userinfo", () => {
    expect(withoutCredentials("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
  });
});

describe("quoted", () => {
  test("escapes control and bidi characters, so the value reads as typed", () => {
    expect(quoted("a\nb")).toBe('"a\\nb"');
    expect(quoted("e\u202Eng")).toBe('"e\\u202Eng"');
    expect(quoted("x\u009By\u2066")).toBe('"x\\u009By\\u2066"');
  });
});

describe("masking long input", () => {
  test("takes linear time on text built to make a backtracking pattern stall", () => {
    const hostile = `${"a".repeat(200_000)}://${"b".repeat(200_000)}`;
    const started = Date.now();
    expect(withoutCredentials(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("still finds userinfo after a long run, and every one in a line", () => {
    expect(withoutCredentials(`${"x".repeat(50)} git+https://t@a.example/x and ssh://u@b/y`)).toBe(
      `${"x".repeat(50)} git+https://<redacted>@a.example/x and ssh://<redacted>@b/y`,
    );
    expect(withoutCredentials("1abc://user@host")).toBe("1abc://<redacted>@host");
  });
});

describe("text from a registry, shown in a terminal", () => {
  const ESC = "\u001B";
  const BEL = "\u0007";

  test("loses every escape sequence, in its 7-bit and 8-bit forms", () => {
    const hostile = [
      `${ESC}]0;title${BEL}`,
      `${ESC}]52;c;Zm9v${ESC}\\`,
      "\u009D8;;https://example.invalid\u009C",
      `${ESC}[31m`,
      "\u009B2J",
      `${ESC}P+q${ESC}\\`,
      `${ESC}c`,
    ].join("");
    expect(sanitizeBlock(`a${hostile}b`)).toBe("ab");
    expect(sanitizeText(`a${hostile}b`)).toBe("ab");
  });

  test("leaves no escape or C1 control even from a sequence cut short", () => {
    for (const cut of [`${ESC}]0;title`, `${ESC}[3`, "\u009D0;t", `${ESC}`]) {
      const left = [...sanitizeBlock(`a${cut}b`)].map((char) => char.codePointAt(0) as number);
      expect(left.filter((code) => code < 0x20 || (code >= 0x7f && code <= 0x9f))).toEqual([]);
    }
  });

  test("takes linear time on sequences that never end", () => {
    const hostile = [`${ESC}]x`, "\u009Dx", `${ESC}[1`, "\u009B1"].map((cut) => cut.repeat(50_000));
    const started = Date.now();
    for (const text of hostile) sanitizeBlock(text);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("drops the bidi controls that make text read in another order (Trojan Source)", () => {
    const reordered = "if \u202Eend\u2066 x\u2069\u202C \u200Fy\u061C";
    expect(sanitizeBlock(reordered)).toBe("if end x y");
    expect(sanitizeText(reordered)).toBe("if end x y");
  });

  test("keeps lines and tabs in a block and folds them on one line", () => {
    expect(sanitizeBlock("a\n\tb\r\nc\rd")).toBe("a\n\tb\r\ncd");
    expect(sanitizeText("a\n\tb")).toBe("a b");
  });

  test("keeps the characters a person's text is made of", () => {
    const text = "Revue de code \u2014 日本語 👩\u200D💻 ü";
    expect(sanitizeBlock(text)).toBe(text);
  });
});

describe("trimming a run of characters", () => {
  test("strips the run from either end", () => {
    expect(stripTrailing("https://example.com/a///", "/")).toBe("https://example.com/a");
    expect(stripLeading("//a/b/", "/")).toBe("a/b/");
    expect(stripTrailing(".git. . ", ". ")).toBe(".git");
    expect(stripTrailing("///", "/")).toBe("");
  });

  test("takes linear time on a run built to make a backtracking pattern stall", () => {
    const hostile = `${"/".repeat(200_000)}a`;
    const started = Date.now();
    expect(stripTrailing(hostile, "/")).toBe(hostile);
    expect(stripLeading(hostile, "/")).toBe("a");
    expect(Date.now() - started).toBeLessThan(100);
  });
});
