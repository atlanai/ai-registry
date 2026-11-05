import { describe, expect, test } from "vitest";
import { type ColorWhen, Printer, type PrinterOptions, Styler, sentence } from "./printer.ts";

function capture(options: PrinterOptions) {
  const out: string[] = [];
  const err: string[] = [];
  const printer = new Printer({
    ...options,
    out: { write: (chunk: string) => out.push(chunk), isTTY: false },
    err: { write: (chunk: string) => err.push(chunk), isTTY: false },
  });
  return { printer, out: () => out.join(""), err: () => err.join("") };
}

describe("Printer", () => {
  test("strips terminal escapes from every diagnostic, where remote text arrives in messages", () => {
    const { printer, err } = capture({ verbose: true });
    const hostile = "zz\u001B]0;title\u0007\u001B]52;c;Zm9v\u0007\u001B[31mred\u202E";
    printer.error(`index.json lists ${hostile}.`);
    printer.warning(hostile);
    printer.hint(hostile);
    printer.field("trace", hostile);
    printer.step(hostile);
    printer.detail(hostile);
    expect(err()).toBe(
      "error: index.json lists zzred.\nwarning: zzred\nhint: zzred\n  trace: zzred\n· zzred\n  zzred\n",
    );
  });

  test("strips escapes from primary output, where manifest and registry text arrive, keeping its own styling", () => {
    const hostile = "zz\u001B]52;c;Zm9v\u0007\u001B[2J\u001B[8mhidden\u202E";
    const plain = capture({ color: "never" });
    plain.printer.info(`acme  ${hostile}`);
    plain.printer.success(hostile);
    plain.printer.note("next", hostile);
    expect(plain.out()).toBe("acme  zzhidden\n✓ zzhidden\n  next   zzhidden\n");

    const styled = capture({ color: "always" });
    styled.printer.info(`${styled.printer.style.bold("acme")} ${hostile}`);
    expect(styled.out()).toBe("\u001B[1macme\u001B[0m zzhidden\n");
  });

  test("keeps the lines of a diagnostic", () => {
    const { printer, err } = capture({});
    printer.error("one\n  two");
    expect(err()).toBe("error: one\n  two\n");
  });

  test("writes --verbose steps and details to stderr, never stdout", () => {
    const { printer, out, err } = capture({ verbose: true });
    printer.step("acme: /x");
    printer.detail("d");
    expect(out()).toBe("");
    expect(err()).toBe("· acme: /x\n  d\n");
  });

  test("prints only results, warnings, errors and their hints under --quiet", () => {
    const { printer, out, err } = capture({ quiet: true });
    printer.info("r");
    printer.success("s");
    printer.note("next", "n");
    printer.hint("alone");
    printer.warning("w");
    printer.hint("about w");
    printer.error("e");
    printer.field("code", "USAGE");
    printer.hint("about e");
    printer.info("r2");
    printer.hint("late");
    expect(out()).toBe("r\nr2\n");
    expect(err()).toBe("warning: w\nhint: about w\nerror: e\n  code: USAGE\nhint: about e\n");
  });
});

describe("Styler", () => {
  test("lets --color win over the environment, then NO_COLOR, then forcing, then CLICOLOR=0", () => {
    const on = (env: NodeJS.ProcessEnv, when?: ColorWhen, isTTY = false) =>
      new Styler({ isTTY }, env, when).red("x") !== "x";
    expect(on({ FORCE_COLOR: "1" }, "never")).toBe(false);
    expect(on({ NO_COLOR: "1" }, "always")).toBe(true);
    expect(on({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
    expect(on({ CLICOLOR_FORCE: "1" })).toBe(true);
    expect(on({ FORCE_COLOR: "" })).toBe(false);
    expect(on({}, "auto", true)).toBe(true);
    expect(on({ CLICOLOR: "0" }, "auto", true)).toBe(false);
    expect(on({ CLICOLOR: "0", CLICOLOR_FORCE: "1" })).toBe(true);
  });

  test("leaves empty text unstyled", () => {
    expect(new Styler({ isTTY: true }, { FORCE_COLOR: "1" }).dim("")).toBe("");
  });
});

describe("sentence", () => {
  test.each([
    ["not found", "not found."],
    ["fatal: bad ref\n", "fatal: bad ref."],
    ["Already ended!", "Already ended!"],
  ])("ends %j once", (text, ended) => {
    expect(sentence(text)).toBe(ended);
  });
});
