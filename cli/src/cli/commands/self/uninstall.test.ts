import { beforeEach, describe, expect, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { stopEverything, survey } from "./uninstall.ts";

// Never the real service manager or daemon: each is what this machine happens to run.
const machine = vi.hoisted(() => ({
  running: false,
  registered: false,
  changed: false as boolean | undefined,
  stopped: 0,
}));

vi.mock("#daemon/process/lifecycle.ts", () => ({
  probeDaemon: async () => ({ status: machine.running ? "ready" : "down" }),
  stopDaemon: async () => {
    machine.stopped += 1;
  },
}));

vi.mock("#daemon/autostart/index.ts", () => ({
  autostartState: async () => ({ registered: machine.registered }),
  disableAutostart: async () =>
    machine.changed === undefined ? undefined : { changed: machine.changed },
}));

// Nor its Windows user PATH, which PowerShell takes a second or two to read.
vi.mock("#self/windows-path.ts", async (actual) => ({
  ...(await actual<typeof import("#self/windows-path.ts")>()),
  userPathHas: async () => false,
}));

beforeEach(() => {
  Object.assign(machine, { running: false, registered: false, changed: false, stopped: 0 });
});

describe("survey", () => {
  test("names a running daemon and its autostart before aireg's files", async ({ home }) => {
    machine.running = true;
    machine.registered = true;
    const found = await survey(home.env);
    expect(Object.keys(found)).toEqual([
      "daemon",
      "autostart",
      "links",
      "startupFiles",
      "folders",
      "kept",
    ]);
    expect(found).toMatchObject({ daemon: true, autostart: true });
  });

  test("finds no daemon or autostart where neither is set up", async ({ home }) => {
    expect(await survey(home.env)).toMatchObject({ daemon: false, autostart: false });
  });
});

describe("stopEverything", () => {
  test("turns autostart off, then stops a daemon started by hand", async () => {
    machine.changed = true;
    expect(await stopEverything()).toEqual({ autostart: true });
    expect(machine.stopped).toBe(1);
  });

  test("says autostart did not change where it was off or unsupported", async () => {
    expect(await stopEverything()).toEqual({ autostart: false });
    machine.changed = undefined;
    expect(await stopEverything()).toEqual({ autostart: false });
    expect(machine.stopped).toBe(2);
  });
});
