import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PUBLIC_FILE } from "#adapter/files.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { readTextIfPresent } from "#core/fs/path.ts";
import { SERVICE } from "#core/product.ts";
import { type AutostartBackend, type Exec, type ServiceSpec, SUPERVISOR_ENV } from "./model.ts";

const LABEL = SERVICE.launchd;
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 200;
/** The first program argument, whatever whitespace the tool that last wrote the plist used. */
const PROGRAM = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/;

/**
 * KeepAlive restarts only a non-zero exit, so `daemon stop` and a redundant
 * daemon exiting 0 stay down, while a crash or an update restart come back.
 */
export function renderPlist(spec: ServiceSpec): string {
  const env = { ...spec.env, [SUPERVISOR_ENV]: "launchd" };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    plistString(launchdLabel(spec.suffix)),
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.daemon.map((arg) => plistString(arg, "    ")),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).flatMap(([key, value]) => [
      `    <key>${escapeXml(key)}</key>`,
      plistString(value, "    "),
    ]),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>LimitLoadToSessionType</key>",
    "  <string>Aqua</string>",
    "  <key>StandardErrorPath</key>",
    plistString(spec.stderrLog),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function plistString(value: string, indent = "  "): string {
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchdLabel(suffix: string): string {
  return suffix === "" ? LABEL : `${LABEL}.${suffix}`;
}

export function launchdBackend(spec: ServiceSpec, exec: Exec): AutostartBackend {
  const label = launchdLabel(spec.suffix);
  const path = join(spec.home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${String(spec.uid)}`;
  const service = `${domain}/${label}`;
  const wanted = renderPlist(spec);
  const loaded = async () => (await exec("launchctl", ["print", service])).code === 0;

  /** A bootout returns before launchd has let go of the label, so the first bootstrap can fail. */
  async function bootstrap(): Promise<void> {
    let last = "";
    for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
      const result = await exec("launchctl", ["bootstrap", domain, path]);
      if (result.code === 0) return;
      last = result.stderr.trim();
      if (attempt < BOOTSTRAP_ATTEMPTS) await sleep(BOOTSTRAP_RETRY_MS);
    }
    throw new AiregError(`launchctl could not load the daemon: ${last}`, {
      code: ErrorCode.Unavailable,
    });
  }

  return {
    mechanism: "launchd",
    supervises: true,
    async state() {
      const found = await readTextIfPresent(path);
      const registered = found !== undefined;
      return {
        mechanism: "launchd",
        location: path,
        registered,
        loaded: registered && (await loaded()),
        current: found === wanted,
      };
    },
    async install() {
      await writeAtomic(path, wanted, PUBLIC_FILE);
      if (await loaded()) await exec("launchctl", ["bootout", service]);
      // Clears a disable a previous `launchctl disable` left behind the file's back.
      await exec("launchctl", ["enable", service]);
      await bootstrap();
    },
    async uninstall() {
      const registered = (await readTextIfPresent(path)) !== undefined;
      const wasLoaded = await loaded();
      if (wasLoaded) await exec("launchctl", ["bootout", service]);
      await rm(path, { force: true });
      return registered || wasLoaded;
    },
    async start() {
      if ((await readTextIfPresent(path)) === undefined || !(await loaded())) return false;
      return (await exec("launchctl", ["kickstart", service])).code === 0;
    },
    async rewrite() {
      await writeAtomic(path, wanted, PUBLIC_FILE);
    },
    async starts(program) {
      const found = await readTextIfPresent(path);
      return found !== undefined && PROGRAM.exec(found)?.[1] === escapeXml(program);
    },
  };
}
