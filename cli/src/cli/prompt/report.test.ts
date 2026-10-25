import { describe, expect, it } from "vitest";
import { Styler } from "#core/output.ts";
import type { PromptIo } from "./prompt.ts";
import { note, spinner } from "./report.ts";

const style = new Styler({ isTTY: false }, {}, "always");
// A clipboard write, a screen clear, a bell, a backspace and a hidden hyperlink.
const HOSTILE =
  "kit\u001B]52;c;Zm9v\u0007\u001B[2J\u0007\b\u001B]8;;https://example.test/\u0007x\u001B]8;;\u0007\u001B[8m";

function capture(): { io: PromptIo; written: () => string } {
  let written = "";
  const io = {
    input: undefined as unknown as NodeJS.ReadStream,
    output: { write: (chunk: string) => (written += chunk) },
  };
  return { io: io as PromptIo, written: () => written };
}

function expectInert(written: string): void {
  for (const found of ["\u001B]", "\u001B[2J", "\u001B[8m", "\u0007", "\b"]) {
    expect(written).not.toContain(found);
  }
}

describe("spinner", () => {
  it("draws registry text as inert text, keeping its own styling", () => {
    const { io, written } = capture();
    const spin = spinner(io, style);
    spin.update(`Reading ${HOSTILE}`);
    spin.stop(`${HOSTILE} publishes 2 artifacts`);
    expectInert(written());
    expect(written()).toContain("Reading kitx");
    expect(written()).toContain(`${style.green("◇")}  kitx publishes 2 artifacts\n`);
  });
});

describe("note", () => {
  it("draws registry text as inert text, keeping its own styling", () => {
    const { io, written } = capture();
    note(io, style, `Remove ${HOSTILE}`, [`${style.dim("from")} ${HOSTILE}`]);
    expectInert(written());
    expect(written()).toContain(`${style.bold("Remove kitx")}`);
    expect(written()).toContain(`${style.dim("from")} kitx`);
  });
});
