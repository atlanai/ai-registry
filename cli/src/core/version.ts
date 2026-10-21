import { compareVersion, parseVersion } from "#adapter/semver.ts";
import { NAME } from "#core/product.ts";

// Replaced at build time; source execution uses a development version.
declare const __VERSION__: string;
declare const __COMMIT__: string;

/** A run from source; dev-ring builds are `X.Y.Z-dev.N` and update like any release. */
const SOURCE_VERSION = "0.0.0-dev";

export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : SOURCE_VERSION;

/** The commit a release build was made from; empty when run from source. */
const COMMIT = typeof __COMMIT__ === "string" ? __COMMIT__ : "";

export function isSourceVersion(version: string): boolean {
  return version === SOURCE_VERSION;
}

/** What `--version --json` reports. */
export function versionInfo(): { version: string; commit?: string } {
  return COMMIT === "" ? { version: VERSION } : { version: VERSION, commit: COMMIT };
}

// Each older major needs its own patched floor; the final floor also admits future majors.
const NODE_MINIMUMS = ["22.23.4", "24.22.1", "26.12.1"];
export const NODE_REQUIREMENT = NODE_MINIMUMS.map(
  (minimum, index) => `${index === NODE_MINIMUMS.length - 1 ? ">=" : "^"}${minimum}`,
).join(" || ");

export function nodeTooOld(
  node = process.versions.node,
  bun: string | undefined = process.versions.bun,
): string | undefined {
  // Bun carries its own certificates; its emulated Node version says nothing about their safety.
  if (bun !== undefined) return undefined;
  const current = parseVersion(node);
  if (current === undefined) return undefined;
  const supported =
    current.prerelease.length === 0 &&
    NODE_MINIMUMS.some((floor, index) => {
      const minimum = parseVersion(floor);
      return (
        minimum !== undefined &&
        (current.major === minimum.major || index === NODE_MINIMUMS.length - 1) &&
        compareVersion(current, minimum) >= 0
      );
    });
  if (supported) return undefined;
  return `${NAME} requires Node.js ${NODE_REQUIREMENT}; this is ${node}.`;
}
