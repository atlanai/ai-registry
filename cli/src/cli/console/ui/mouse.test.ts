import { EventEmitter } from "node:events";
import { render, useInput } from "ink";
import { createElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { useMouse } from "./mouse.ts";

/** A terminal Ink can drive: raw mode recorded, output discarded. */
function terminal() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: vi.fn(),
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
    resume: () => {},
    pause: () => {},
  });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: () => true,
  });
  return { stdin, stdout };
}

function Mouse(): null {
  useMouse(() => {});
  return null;
}

/** Keys while `typing`, and the mouse while `pointing`, as a view might switch them. */
function Probe(props: { typing: boolean; pointing: boolean }) {
  useInput(() => {}, { isActive: props.typing });
  return props.pointing ? createElement(Mouse) : null;
}

describe("useMouse", () => {
  test("hands raw mode back when it unmounts, so the terminal leaves raw mode once nothing reads keys", async () => {
    const { stdin, stdout } = terminal();
    const written = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const app = render(createElement(Probe, { typing: true, pointing: true }), {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await vi.waitFor(() => expect(stdin.setRawMode).toHaveBeenCalledWith(true));
      app.rerender(createElement(Probe, { typing: true, pointing: false }));
      app.rerender(createElement(Probe, { typing: false, pointing: false }));
      await vi.waitFor(() => expect(stdin.setRawMode).toHaveBeenLastCalledWith(false));
    } finally {
      app.unmount();
      written.mockRestore();
    }
  });
});
