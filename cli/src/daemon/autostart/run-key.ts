import { envName } from "#core/env.ts";
import { SERVICE } from "#core/product.ts";
import type { AutostartBackend, Exec, ServiceSpec } from "./model.ts";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * A login hook, not a supervisor: `daemon start` runs once at sign-in and a
 * crash waits for the next command that needs the daemon.
 */
export function runKeyBackend(spec: ServiceSpec, exec: Exec): AutostartBackend {
  const value = runKeyValue(spec.suffix);
  const location = `${RUN_KEY}\\${value}`;
  const read = async () => {
    const result = await exec("reg", ["query", RUN_KEY, "/v", value]);
    return result.code === 0 ? (queried(result.stdout, value) ?? "") : undefined;
  };

  const backend: AutostartBackend = {
    mechanism: "run-key",
    supervises: false,
    async state() {
      const found = await read();
      const registered = found !== undefined;
      return {
        mechanism: "run-key",
        location,
        registered,
        loaded: registered,
        current: found === renderRunCommand(spec),
      };
    },
    async install() {
      // The Run key carries no environment, so a second home would start the default one.
      if (spec.suffix !== "") {
        throw new Error(
          `Autostart on Windows works only with the default home folder, not a custom ${envName("HOME")}.`,
        );
      }
      const result = await exec("reg", [
        "add",
        RUN_KEY,
        "/v",
        value,
        "/t",
        "REG_SZ",
        "/d",
        renderRunCommand(spec),
        "/f",
      ]);
      if (result.code !== 0) throw new Error(`\`reg add\` failed: ${result.stderr.trim()}`);
    },
    async uninstall() {
      if ((await read()) === undefined) return false;
      const result = await exec("reg", ["delete", RUN_KEY, "/v", value, "/f"]);
      if (result.code !== 0) throw new Error(`\`reg delete\` failed: ${result.stderr.trim()}`);
      return true;
    },
    async start() {
      return false;
    },
    async starts(program) {
      return (await read())?.startsWith(`"${program}"`) === true;
    },
    // A Run key value is read at each sign-in, so writing it is all a reload would do.
    rewrite: () => backend.install(),
  };
  return backend;
}

function runKeyValue(suffix: string): string {
  return suffix === "" ? SERVICE.runKey : `${SERVICE.runKey}-${suffix}`;
}

/** The data column of `reg query` output: name, type, then the rest of the line. */
function queried(stdout: string, value: string): string | undefined {
  for (const row of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+REG_SZ\s+(.*)$/.exec(row);
    if (match?.[1] === value) return match[2]?.trim();
  }
  return undefined;
}

/** Windows paths cannot hold a quote, so quoting each argument is enough. */
function renderRunCommand(spec: ServiceSpec): string {
  return spec.starter
    .map((arg) => {
      if (arg.includes('"')) throw new Error("The daemon's login command cannot contain a quote.");
      return `"${arg}"`;
    })
    .join(" ");
}
