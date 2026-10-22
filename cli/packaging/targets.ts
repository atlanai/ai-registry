import { readFileSync } from "node:fs";
import { releaseBinary } from "#core/product.ts";
import { RELEASE_PLATFORMS, type ReleasePlatform, releasePlatform } from "#core/release/urls.ts";

/**
 * Exact, never a range: a standalone binary IS its Bun runtime, so `latest` would make every
 * release a different, untested runtime. `.bun-version` is also what CI installs.
 */
export const BUN_VERSION = readFileSync(new URL("../.bun-version", import.meta.url), "utf8").trim();
export const BUN_COMMIT = (
  JSON.parse(readFileSync(new URL("./bun-runtime.json", import.meta.url), "utf8")) as {
    commit: string;
  }
).commit;

export interface Target {
  readonly platform: ReleasePlatform;
  readonly os: string;
  readonly arch: string;
  /** `--target` for `bun build --compile`. */
  readonly bunTarget: string;
  /** Published artifact name, and the name install.sh downloads. */
  readonly filename: string;
}

/** Artifacts keep the CLI's `amd64`; Bun spells it `x64`, as Node does. */
function target(platform: ReleasePlatform): Target {
  const [os = "", arch = ""] = platform.split("-");
  return {
    platform,
    os,
    arch,
    bunTarget: `bun-${os}-${arch === "amd64" ? "x64" : arch}`,
    filename: releaseBinary(platform),
  };
}

/** One per release platform, so a platform aireg can download is one it builds. */
export const TARGETS: readonly Target[] = RELEASE_PLATFORMS.map(target);

export function findTarget(os: string, arch: string): Target | undefined {
  return TARGETS.find((entry) => entry.os === os && entry.arch === arch);
}

/** The pair this host runs, which `release:compile` builds when no target is named. */
export function hostTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): Target | undefined {
  const name = releasePlatform(platform, arch);
  return name === undefined ? undefined : TARGETS.find((entry) => entry.platform === name);
}
