import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { fakeExec } from "#test/kit/fake-exec.ts";
import { test } from "#test/kit/fixtures.ts";
import { expectMode } from "#test/kit/mode.ts";
import { launchdBackend, renderPlist } from "./launchd.ts";
import type { ServiceSpec } from "./model.ts";

function spec(home: string, suffix = ""): ServiceSpec {
  return {
    suffix,
    daemon: ["/Users/u/.aireg/bin/aireg", "--internal-daemon"],
    starter: ["/Users/u/.aireg/bin/aireg", "daemon", "start"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    stderrLog: "/Users/u/.aireg/logs/daemon-stderr.log",
    home,
    configHome: join(home, ".config"),
    uid: 501,
  };
}

describe("renderPlist", () => {
  test("restarts a crash but not a clean stop, and marks the supervisor", () => {
    const plist = renderPlist(spec("/Users/u"));
    expect(plist).toContain("<key>Label</key>\n  <string>sh.aireg.daemon</string>");
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>",
    );
    expect(plist).toContain("<string>/Users/u/.aireg/bin/aireg</string>");
    expect(plist).toContain("<string>--internal-daemon</string>");
    expect(plist).toContain("<key>AIREG_DAEMON_SUPERVISOR</key>\n    <string>launchd</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("escapes markup in paths", () => {
    const plist = renderPlist({
      ...spec("/Users/u"),
      daemon: ["/a&b/<registry>", "--internal-daemon"],
    });
    expect(plist).toContain("<string>/a&amp;b/&lt;registry&gt;</string>");
  });

  test("keeps a second home's label apart", () => {
    expect(renderPlist(spec("/Users/u", "0123abcd"))).toContain(
      "<key>Label</key>\n  <string>sh.aireg.daemon.0123abcd</string>",
    );
  });
});

describe("launchdBackend", () => {
  let home: string;
  const plistPath = () => join(home, "Library", "LaunchAgents", "sh.aireg.daemon.plist");

  test.beforeEach(async ({ tmp }) => {
    home = tmp;
  });
  test("reports nothing registered without asking launchctl", async () => {
    const fake = fakeExec();
    const state = await launchdBackend(spec(home), fake.exec).state();
    expect(state).toEqual({
      mechanism: "launchd",
      location: plistPath(),
      registered: false,
      loaded: false,
      current: false,
    });
    expect(fake.calls).toEqual([]);
  });

  test("writes a user-only-writable agent and bootstraps it into the gui domain", async () => {
    const fake = fakeExec({
      "launchctl print gui/501/sh.aireg.daemon": { code: 113 },
    });
    await launchdBackend(spec(home), fake.exec).install();
    await expectMode(plistPath(), 0o644);
    expect(await readFile(plistPath(), "utf8")).toBe(renderPlist(spec(home)));
    expect(fake.calls).toEqual([
      "launchctl print gui/501/sh.aireg.daemon",
      "launchctl enable gui/501/sh.aireg.daemon",
      `launchctl bootstrap gui/501 ${plistPath()}`,
    ]);
  });

  test("boots out a loaded agent before loading the new definition", async () => {
    const fake = fakeExec();
    await launchdBackend(spec(home), fake.exec).install();
    expect(fake.calls[1]).toBe("launchctl bootout gui/501/sh.aireg.daemon");
  });

  test("retries a bootstrap that races the previous job's teardown", async () => {
    let attempts = 0;
    const fake = fakeExec({
      "launchctl print gui/501/sh.aireg.daemon": { code: 113 },
    });
    const exec: typeof fake.exec = async (file, args) => {
      if (args[0] === "bootstrap" && attempts++ === 0) {
        return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return fake.exec(file, args);
    };
    await launchdBackend(spec(home), exec).install();
    expect(attempts).toBe(2);
  });

  test("surfaces a bootstrap that keeps failing", async () => {
    const fake = fakeExec({
      "launchctl print gui/501/sh.aireg.daemon": { code: 113 },
      [`launchctl bootstrap gui/501 ${join(home, "Library", "LaunchAgents", "sh.aireg.daemon.plist")}`]:
        { code: 5, stderr: "Bootstrap failed: 5: Input/output error" },
    });
    await expect(launchdBackend(spec(home), fake.exec).install()).rejects.toThrow(
      /launchctl could not load the daemon: Bootstrap failed: 5/,
    );
  });

  test("reads a definition written for another install as not current", async () => {
    const fake = fakeExec();
    const backend = launchdBackend(spec(home), fake.exec);
    await backend.install();
    await writeFile(plistPath(), "<plist/>");
    expect(await backend.state()).toMatchObject({ registered: true, loaded: true, current: false });
  });

  test("boots out and deletes on uninstall, and reports no change the second time", async () => {
    const fake = fakeExec();
    const backend = launchdBackend(spec(home), fake.exec);
    await backend.install();
    fake.calls.length = 0;
    expect(await backend.uninstall()).toBe(true);
    expect(fake.calls).toContain("launchctl bootout gui/501/sh.aireg.daemon");
    await expect(stat(plistPath())).rejects.toMatchObject({ code: "ENOENT" });
    fake.answer("launchctl print gui/501/sh.aireg.daemon", { code: 113 });
    expect(await backend.uninstall()).toBe(false);
  });

  test("starts through kickstart only when the agent is loaded", async () => {
    const fake = fakeExec();
    const backend = launchdBackend(spec(home), fake.exec);
    expect(await backend.start()).toBe(false);
    await backend.install();
    expect(await backend.start()).toBe(true);
    expect(fake.calls.at(-1)).toBe("launchctl kickstart gui/501/sh.aireg.daemon");
  });
});
