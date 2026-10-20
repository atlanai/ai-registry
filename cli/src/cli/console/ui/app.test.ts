import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountRow, ConsoleState } from "#core/console/model.ts";
import type { HostCommandContext } from "#core/host/extend.ts";
import { App } from "./app.ts";

const account: AccountRow = {
  id: "acc_1",
  registry: "my-skills",
  address: "file:///srv/git/my-skills.git",
  config: {},
  credentialsFile: undefined,
  signedIn: false,
  signIn: false,
  publishes: false,
  defaultNamespace: undefined,
  artifactCount: 0,
  namespaceCount: 0,
};

const state: ConsoleState = {
  version: "0.0.0",
  account,
  accounts: [account],
  groups: [],
  summary: {
    skillsImported: 0,
    skillsExamined: 0,
    failed: 0,
    edited: 0,
    dangling: 0,
    missing: 0,
    pending: 0,
    imported: 0,
    unpublished: 0,
    duplicate: 0,
  },
  jobs: [],
  runs: [],
  daemon: { running: false, pid: undefined, jobsEnabled: 0, jobsTotal: 0 },
  policy: undefined,
  scope: "user",
  root: "/nowhere",
  readAtMs: 0,
  problems: [],
  panels: {},
};

/** Real streams exercise Ink's input parsing and output flush callbacks. */
async function terminal(size?: { rows: number; columns: number }) {
  const writes: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callback();
    },
  });
  if (size !== undefined) Object.assign(stdout, size, { isTTY: true });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const instance = render(
    createElement(App, {
      context: {} as HostCommandContext,
      initial: state,
      panels: [],
      upstream: undefined,
      viewer: undefined,
    }),
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await instance.waitUntilRenderFlush();
  return {
    stdout,
    async press(keys: string[]) {
      for (const key of keys) stdin.write(key);
      await instance.waitUntilRenderFlush();
    },
    async lines() {
      await instance.waitUntilRenderFlush();
      // Mouse mode switches share stdout; only frames contain the view tabs.
      const frame = writes.findLast((chunk) => chunk.includes("Overview")) ?? "";
      return stripVTControlCharacters(frame).trimEnd().split("\n");
    },
    async close() {
      instance.unmount();
      await instance.waitUntilExit();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

async function screen(rows: number, columns: number, keys: string[] = []): Promise<string[]> {
  const app = await terminal({ rows, columns });
  try {
    await app.press(keys);
    return await app.lines();
  } finally {
    await app.close();
  }
}

describe("App", () => {
  // Ink writes a newline after every frame, so a frame as tall as the terminal
  // scrolls it by one row and the header leaves the screen.
  it("leaves the last row free so the header stays on screen", async () => {
    const lines = await screen(24, 100);
    expect(lines).toHaveLength(23);
    expect(lines[0]).toMatch(/^◆ aireg console /);
    expect(lines.at(-1)).toMatch(/v0\.0\.0$/);
  });

  it("says there are no runs yet rather than leaving the section blank", async () => {
    const lines = await screen(30, 100);
    const recent = lines.findIndex((line) => line.startsWith("RECENT"));
    expect(lines[recent + 1]?.trim()).toBe("No runs yet.");
  });

  it("keeps the header and footer when an overlay is taller than the screen", async () => {
    const lines = await screen(24, 100, ["?"]);
    expect(lines).toHaveLength(23);
    expect(lines.join("\n")).toContain("previous or next view");
    expect(lines[0]).toMatch(/^◆ aireg console /);
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toMatch(/^my-skills \[1\] /);
    expect(lines[3]).toMatch(/^─+$/);
    expect(lines[4]).toContain("Overview");
    expect(lines.at(-1)).toMatch(/v0\.0\.0$/);
  });

  it("redraws at the new terminal dimensions after a resize", async () => {
    const app = await terminal({ rows: 30, columns: 100 });
    try {
      expect(await app.lines()).toHaveLength(29);
      Object.assign(app.stdout, { rows: 24, columns: 80 });
      app.stdout.emit("resize");
      await vi.waitFor(async () => {
        const lines = await app.lines();
        expect(lines.length).toBeLessThanOrEqual(23);
        expect(lines[1]).toHaveLength(80);
        expect(lines[0]).toMatch(/^◆ aireg console /);
        expect(lines.at(-1)).toMatch(/v0\.0\.0$/);
      });
    } finally {
      await app.close();
    }
  });

  it("renders to a writable stream without terminal dimensions", async () => {
    const app = await terminal();
    try {
      const lines = await app.lines();
      expect(lines.length).toBeGreaterThanOrEqual(20);
      expect(lines[0]).toMatch(/^◆ aireg console /);
      expect(lines[4]).toContain("Overview");
      expect(lines.at(-1)).toMatch(/v0\.0\.0$/);
    } finally {
      await app.close();
    }
  });
});
