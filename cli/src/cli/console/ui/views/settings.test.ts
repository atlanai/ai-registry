import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { describe, expect, test } from "vitest";
import type { ConsoleState } from "#core/console/model.ts";
import { settingsView } from "./settings.ts";

function drawn(state: Partial<ConsoleState>): string {
  const writes: string[] = [];
  const stdout = {
    columns: 120,
    rows: 40,
    write: (chunk: string) => writes.push(chunk),
    on() {},
    off() {},
  };
  const instance = render(
    settingsView({
      width: 120,
      state: { jobs: [], ...state } as ConsoleState,
      cursor: -1,
      extra: [],
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  const frame = writes.at(-1) ?? "";
  instance.unmount();
  return stripVTControlCharacters(frame);
}

describe("settingsView", () => {
  test("shows a delete policy that is on as on", () => {
    const frame = drawn({ policy: { pull: "on", publish: "on", delete: "on" } });
    expect(frame).toContain("remove what vanished");
  });

  test("shows every policy axis, with an absent adopt following publish", () => {
    const frame = drawn({ policy: { pull: "on", publish: "report", delete: "off" } });
    expect(frame).toMatch(/adopt\s.*say it is new, send nothing/);
    expect(frame).toMatch(/claim\s.*do not look/);
  });
});
