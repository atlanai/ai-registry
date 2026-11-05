import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { envName } from "#core/env.ts";
import { HOME_DIR, NAME } from "#core/product.ts";
import type { ReleasePlatform } from "#core/release/platform.ts";
import { TARGETS } from "#packaging/targets.ts";
import { artifactBaseUrl, artifactsUrl, installerOrigin } from "./origin.ts";

const SH_TEMPLATE = new URL("install.sh.tmpl", import.meta.url);
const POWERSHELL_TEMPLATE = new URL("install.ps1.tmpl", import.meta.url);

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

export interface InstallerConfig {
  readonly version: string;
  /** The https release origin, such as https://aireg.sh. */
  readonly origin: string;
  /** Directory holding the compiled `aireg-<os>-<arch>[.exe]` assets. */
  readonly binaryDir: string;
}

const DIGEST_KEY = {
  "darwin-amd64": "DarwinAMD64",
  "darwin-arm64": "DarwinARM64",
  "linux-amd64": "LinuxAMD64",
  "linux-arm64": "LinuxARM64",
  "windows-amd64": "WindowsAMD64",
  "windows-arm64": "WindowsARM64",
} as const satisfies Record<ReleasePlatform, string>;

/**
 * Fails on a name with no value or a value with no name; the second catches a renamed
 * placeholder, which ships a script that can never match.
 */
export function renderTemplate(source: string, values: Readonly<Record<string, string>>): string {
  const unused = new Set(Object.keys(values));
  const rendered = source.replace(PLACEHOLDER, (_match: string, key: string): string => {
    const value = values[key];
    if (value === undefined) throw new Error(`installer template has no value for {{${key}}}`);
    unused.delete(key);
    return value;
  });
  if (unused.size > 0) {
    throw new Error(`installer template never used ${[...unused].sort().join(", ")}`);
  }
  return rendered;
}

function digestOf(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size === 0) throw new Error(`${path} is not a built binary`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The values both installers share, and the digests of the platforms `windows` selects. */
function installerValues(config: InstallerConfig, windows: boolean): Record<string, string> {
  const origin = installerOrigin(config.origin);
  const artifactBase = artifactBaseUrl(config.origin, config.version);
  const artifacts = artifactsUrl(config.origin);
  if (origin === undefined || artifactBase === undefined || artifacts === undefined) {
    throw new Error("installer needs an https origin with a plain path and an exact version");
  }
  const values: Record<string, string> = {
    Version: config.version,
    Origin: origin,
    ArtifactBase: artifactBase,
    Artifacts: artifacts,
    VersionEnv: envName("VERSION"),
    Name: NAME,
    HomeDir: HOME_DIR,
    HomeEnv: envName("HOME"),
  };
  for (const target of TARGETS) {
    if ((target.os === "windows") !== windows) continue;
    values[DIGEST_KEY[target.platform]] = digestOf(join(config.binaryDir, target.filename));
  }
  return values;
}

/** `install.sh`, for macOS and Linux. */
export function renderInstaller(config: InstallerConfig): string {
  return renderTemplate(readFileSync(SH_TEMPLATE, "utf8"), installerValues(config, false));
}

/** `install.ps1`, for Windows. */
export function renderWindowsInstaller(config: InstallerConfig): string {
  return renderTemplate(readFileSync(POWERSHELL_TEMPLATE, "utf8"), installerValues(config, true));
}
