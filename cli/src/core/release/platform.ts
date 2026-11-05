import { AiregError, ErrorCode } from "#core/errors.ts";

/** Closed set: the name is a path segment on the release origin, so it must be vetted. */
export const RELEASE_PLATFORMS = [
  "darwin-amd64",
  "darwin-arm64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64",
] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/** Maps, so a lookup of `constructor` misses instead of hitting Object.prototype. */
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
