import { sha256 } from "#adapter/spec/canonical.ts";
import { quoted, stripTrailing } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { RESERVED_KEYS } from "#core/fields.ts";
import { NAME } from "#core/product.ts";

export type SourceConfig = Readonly<Record<string, string>>;

/**
 * Trimmed and sorted by key, so one selection hashes and saves the same way everywhere. A blank,
 * reserved or repeated key throws.
 */
export function canonicalConfig(config: SourceConfig): Record<string, string> {
  const entries = Object.entries(config)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key === "" || value === "")
      throw new AiregError("Registry config keys and values must not be empty.", {
        code: ErrorCode.Usage,
      });
    if (RESERVED_KEYS.has(key))
      throw new AiregError(`${quoted(key)} cannot name a registry config key.`, {
        code: ErrorCode.Usage,
      });
    if (Object.hasOwn(canonical, key))
      throw new AiregError(`Registry config repeats ${quoted(key)}.`, { code: ErrorCode.Usage });
    canonical[key] = value;
  }
  return canonical;
}

/** For comparing two addresses: one `canonicalLocation` refuses is compared as written. */
export function comparableLocation(location: string): string {
  try {
    return canonicalLocation(location);
  } catch {
    return location;
  }
}

/**
 * One spelling for one address, so an endpoint typed with a trailing slash and
 * the same endpoint without one are recognized as the same place.
 */
function canonicalLocation(location: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return stripTrailing(location, "/");
  }
  // An ssh user names the account to sign in as, such as git@; a password is a secret.
  const user = url.protocol === "ssh:" ? "" : url.username;
  if (user !== "" || url.password !== "") {
    throw new AiregError("A registry address must not contain credentials.", {
      code: ErrorCode.Usage,
    });
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AiregError("A registry address must not contain a query or fragment.", {
      code: ErrorCode.Usage,
    });
  }
  url.pathname = stripTrailing(url.pathname, "/");
  return url.href;
}

/**
 * Identity of the thing being read, not of the code reading it: the adapter is
 * absent so a lockfile stays valid when the source changes protocol.
 */
export function sourceKey(location: string, config: SourceConfig): string {
  const canonical = JSON.stringify([
    `${NAME}-source-v1`,
    canonicalLocation(location),
    Object.entries(canonicalConfig(config)),
  ]);
  return sha256(canonical);
}
