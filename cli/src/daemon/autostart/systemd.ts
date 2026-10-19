import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PUBLIC_FILE } from "#core/fs/mode.ts";
import { readTextIfPresent } from "#core/fs/path.ts";
import { SERVICE } from "#core/product.ts";
import { type AutostartBackend, type Exec, type ServiceSpec, SUPERVISOR_ENV } from "./model.ts";

function systemdUnit(suffix: string): string {
  return suffix === "" ? `${SERVICE.systemd}.service` : `${SERVICE.systemd}-${suffix}.service`;
}

function line(value: string): string {
  if (/[\r\n]/.test(value))
    throw new AiregError("The daemon's service file cannot hold a value with a line break.", {
      code: ErrorCode.Invalid,
    });
  return value.replace(/%/g, "%%");
}

/** Quoted so spaces survive; `$` is doubled because ExecStart expands variables. */
function execArg(value: string): string {
  return `"${line(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;
}

function environment(key: string, value: string): string {
  return `Environment="${line(`${key}=${value}`).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Restart=on-failure leaves a clean `daemon stop` down and brings a crash or an update restart back. */
export function renderUnit(spec: ServiceSpec): string {
  const env = { ...spec.env, [SUPERVISOR_ENV]: "systemd" };
  return [
    "[Unit]",
    "Description=aireg background daemon",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${spec.daemon.map(execArg).join(" ")}`,
    ...Object.entries(env).map(([key, value]) => environment(key, value)),
    "Restart=on-failure",
    "RestartSec=5",
    `StandardError=append:${line(spec.stderrLog)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function systemdBackend(spec: ServiceSpec, exec: Exec): AutostartBackend {
  const unit = systemdUnit(spec.suffix);
  const path = join(spec.configHome, "systemd", "user", unit);
  const systemctl = (...args: string[]) => exec("systemctl", ["--user", ...args]);
  const enabled = async () => (await systemctl("is-enabled", unit)).code === 0;

  async function must(...args: string[]): Promise<void> {
    const result = await systemctl(...args);
    if (result.code !== 0) {
      throw new Error(`\`systemctl --user ${args[0]}\` failed: ${result.stderr.trim()}`);
    }
  }

  return {
    mechanism: "systemd",
    supervises: true,
    async state() {
      const found = await readTextIfPresent(path);
      const registered = found !== undefined;
      return {
        mechanism: "systemd",
        location: path,
        registered,
        loaded: registered && (await enabled()),
        current: found === renderUnit(spec),
      };
    },
    async install() {
      // A session without systemd has no user manager to hand the unit to.
      if ((await systemctl("show-environment")).code !== 0) {
        throw new Error(
          "The systemd user manager is not available in this session, so the daemon cannot start at login.",
        );
      }
      await writeAtomic(path, renderUnit(spec), PUBLIC_FILE);
      await must("daemon-reload");
      await must("enable", unit);
      await must("restart", unit);
    },
    async uninstall() {
      const registered = (await readTextIfPresent(path)) !== undefined;
      const wasEnabled = await enabled();
      if (!registered && !wasEnabled) return false;
      await systemctl("disable", "--now", unit);
      await rm(path, { force: true });
      await systemctl("daemon-reload");
      return true;
    },
    async start() {
      if ((await readTextIfPresent(path)) === undefined || !(await enabled())) return false;
      return (await systemctl("start", unit)).code === 0;
    },
    async rewrite() {
      await writeAtomic(path, renderUnit(spec), PUBLIC_FILE);
      await must("daemon-reload");
    },
    async starts(program) {
      const head = `ExecStart=${execArg(program)}`;
      const found = await readTextIfPresent(path);
      return found?.split("\n").some((row) => row === head || row.startsWith(`${head} `)) === true;
    },
  };
}
