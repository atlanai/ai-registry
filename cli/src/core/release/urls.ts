import { AiregError, ErrorCode } from "#core/errors.ts";
import { NAME, releaseBinary } from "#core/product.ts";

export const BINARY_NAME = NAME;

/**
 * A closed set, because the artifact filename is a path segment on the release
 * origin: an unrecognized platform has no name rather than an unvetted one.
 */
export const RELEASE_PLATFORMS = [
  "darwin-amd64",
  "darwin-arm64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64",
] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/**
 * Maps rather than object literals, so a lookup of `constructor` or `toString`
 * misses instead of returning something off Object.prototype.
 */
const OS = new Map<string, string>([
  ["darwin", "darwin"],
  ["linux", "linux"],
  ["win32", "windows"],
]);
const ARCH = new Map<string, string>([
  ["x64", "amd64"],
  ["arm64", "arm64"],
]);

export function releasePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): ReleasePlatform | undefined {
  const os = OS.get(platform);
  const cpu = ARCH.get(arch);
  if (os === undefined || cpu === undefined) return undefined;
  const name = `${os}-${cpu}`;
  return (RELEASE_PLATFORMS as readonly string[]).includes(name)
    ? (name as ReleasePlatform)
    : undefined;
}

/** The same lookup where having no build is fatal rather than a value to carry. */
export function requireReleasePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): ReleasePlatform {
  const found = releasePlatform(platform, arch);
  if (found === undefined)
    throw new AiregError(`No aireg build is published for ${platform}-${arch}.`, {
      code: ErrorCode.Unavailable,
    });
  return found;
}

/** The single executable this platform downloads; there is nothing to unpack. */
export function binaryName(platform: ReleasePlatform): string {
  return releaseBinary(platform);
}
