import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { fakeExec } from "#test/kit/fake-exec.ts";
import { test } from "#test/kit/fixtures.ts";
import { expectMode } from "#test/kit/mode.ts";
import type { ServiceSpec } from "./model.ts";
import { renderUnit, systemdBackend } from "./systemd.ts";

function spec(home: string, suffix = ""): ServiceSpec {
  return {
    suffix,
    daemon: ["/home/u/.aireg/bin/aireg", "--internal-daemon"],
    starter: ["/home/u/.aireg/bin/aireg", "daemon", "start"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    stderrLog: "/home/u/.aireg/logs/daemon-stderr.log",
    home,
    configHome: join(home, ".config"),
    uid: 1000,
  };
}

describe("renderUnit", () => {
  test("restarts on failure only, and marks the supervisor", () => {
    const unit = renderUnit(spec("/home/u"));
    expect(unit).toContain('ExecStart="/home/u/.aireg/bin/aireg" "--internal-daemon"');
    expect(unit).toContain('Environment="AIREG_DAEMON_SUPERVISOR=systemd"');
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("escapes quotes, specifiers and variables", () => {
    const unit = renderUnit({
      ...spec("/home/u"),
      daemon: ['/opt/a "b"/100%/$HOME/registry', "--internal-daemon"],
      env: { PATH: "/x%y" },
    });
    expect(unit).toContain('ExecStart="/opt/a \\"b\\"/100%%/$$HOME/registry" "--internal-daemon"');
    expect(unit).toContain('Environment="PATH=/x%%y"');
  });

  test("refuses a value that would end the line", () => {
    expect(() => renderUnit({ ...spec("/home/u"), env: { PATH: "/a\nExecStart=/evil" } })).toThrow(
      /line break/,
    );
  });
});

describe("systemdBackend", () => {
  let home: string;
  const unitPath = () => join(home, ".config", "systemd", "user", "aireg-daemon.service");

  test.beforeEach(async ({ tmp }) => {
    home = tmp;
  });
  test("writes the unit, reloads, enables and restarts it", async () => {
    const fake = fakeExec();
    await systemdBackend(spec(home), fake.exec).install();
    await expectMode(unitPath(), 0o644);
    expect(await readFile(unitPath(), "utf8")).toBe(renderUnit(spec(home)));
    expect(fake.calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "systemctl --user enable aireg-daemon.service",
      "systemctl --user restart aireg-daemon.service",
    ]);
  });

  test("knows which program the unit on disk runs", async () => {
    const fake = fakeExec();
    const backend = systemdBackend(spec(home), fake.exec);
    expect(await backend.starts("/home/u/.aireg/bin/aireg")).toBe(false);
    await backend.install();
    expect(await backend.starts("/home/u/.aireg/bin/aireg")).toBe(true);
    expect(await backend.starts("/home/u/.aireg/bin")).toBe(false);
  });

  // A reload makes the new unit the one the next start runs; nothing is restarted now.
  test("rewrites the unit and reloads without restarting it", async () => {
    const fake = fakeExec();
    await systemdBackend(spec(home), fake.exec).rewrite();
    expect(await readFile(unitPath(), "utf8")).toBe(renderUnit(spec(home)));
    expect(fake.calls).toEqual(["systemctl --user daemon-reload"]);
  });

  test("refuses when there is no user service manager, before writing anything", async () => {
    const fake = fakeExec({
      "systemctl --user show-environment": { code: 1, stderr: "Failed to connect to bus" },
    });
    await expect(systemdBackend(spec(home), fake.exec).install()).rejects.toThrow(
      /systemd user manager is not available/,
    );
    await expect(stat(unitPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("surfaces a unit systemd will not enable", async () => {
    const fake = fakeExec({
      "systemctl --user enable aireg-daemon.service": { code: 1, stderr: "bad unit" },
    });
    await expect(systemdBackend(spec(home), fake.exec).install()).rejects.toThrow(
      /`systemctl --user enable` failed: bad unit/,
    );
  });

  test("reads enablement from is-enabled", async () => {
    const fake = fakeExec({
      "systemctl --user is-enabled aireg-daemon.service": { code: 1 },
    });
    const backend = systemdBackend(spec(home), fake.exec);
    await backend.install();
    expect(await backend.state()).toEqual({
      mechanism: "systemd",
      location: unitPath(),
      registered: true,
      loaded: false,
      current: true,
    });
  });

  test("disables, deletes and reloads on uninstall", async () => {
    const fake = fakeExec();
    const backend = systemdBackend(spec(home), fake.exec);
    await backend.install();
    fake.calls.length = 0;
    expect(await backend.uninstall()).toBe(true);
    expect(fake.calls).toEqual([
      "systemctl --user is-enabled aireg-daemon.service",
      "systemctl --user disable --now aireg-daemon.service",
      "systemctl --user daemon-reload",
    ]);
    await expect(stat(unitPath())).rejects.toMatchObject({ code: "ENOENT" });
    fake.answer("systemctl --user is-enabled aireg-daemon.service", { code: 1 });
    expect(await backend.uninstall()).toBe(false);
  });

  test("keeps a second home's unit apart", async () => {
    const state = await systemdBackend(spec(home, "0123abcd"), fakeExec().exec).state();
    expect(state.location).toBe(
      join(home, ".config", "systemd", "user", "aireg-daemon-0123abcd.service"),
    );
  });

  test("starts through systemctl only when the unit is enabled", async () => {
    const fake = fakeExec();
    const backend = systemdBackend(spec(home), fake.exec);
    expect(await backend.start()).toBe(false);
    await backend.install();
    expect(await backend.start()).toBe(true);
    expect(fake.calls.at(-1)).toBe("systemctl --user start aireg-daemon.service");
  });
});
