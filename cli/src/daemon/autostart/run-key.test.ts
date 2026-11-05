import { describe, expect, test } from "vitest";
import { fakeExec } from "#test/kit/fake-exec.ts";
import type { ServiceSpec } from "./model.ts";
import { runKeyBackend } from "./run-key.ts";

const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function spec(suffix = ""): ServiceSpec {
  return {
    suffix,
    daemon: ["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\registry.mjs", "--internal-daemon"],
    starter: ["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\registry.mjs", "daemon", "start"],
    env: {},
    stderrLog: "C:\\Users\\u\\.registry\\logs\\daemon-stderr.log",
    home: "C:\\Users\\u",
    configHome: "C:\\Users\\u\\.config",
    uid: -1,
  };
}

const COMMAND = '"C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\registry.mjs" "daemon" "start"';

describe("runKeyBackend", () => {
  test("adds the quoted login command under the per-user Run key", async () => {
    const fake = fakeExec();
    await runKeyBackend(spec(), fake.exec).install();
    expect(fake.calls).toEqual([`reg add ${KEY} /v AiregDaemon /t REG_SZ /d ${COMMAND} /f`]);
  });

  test("reads the registered command back out of reg query", async () => {
    const fake = fakeExec({
      [`reg query ${KEY} /v AiregDaemon`]: {
        stdout: `\r\n${KEY}\r\n    AiregDaemon    REG_SZ    ${COMMAND}\r\n\r\n`,
      },
    });
    expect(await runKeyBackend(spec(), fake.exec).state()).toEqual({
      mechanism: "run-key",
      location: `${KEY}\\AiregDaemon`,
      registered: true,
      loaded: true,
      current: true,
    });
  });

  test("deletes only a value that exists", async () => {
    const fake = fakeExec({ [`reg query ${KEY} /v AiregDaemon`]: { code: 1 } });
    const backend = runKeyBackend(spec(), fake.exec);
    expect(await backend.uninstall()).toBe(false);
    fake.answer(`reg query ${KEY} /v AiregDaemon`, { code: 0, stdout: "" });
    expect(await backend.uninstall()).toBe(true);
    expect(fake.calls.at(-1)).toBe(`reg delete ${KEY} /v AiregDaemon /f`);
  });

  test("refuses a second home, which the Run key cannot carry", async () => {
    await expect(runKeyBackend(spec("0123abcd"), fakeExec().exec).install()).rejects.toThrow(
      /default home/,
    );
  });
});
