import { setting } from "#core/env.ts";
import { decodeTrustedKeys, type TrustedKeys } from "./keyring.ts";
import { type Channel, DEFAULT_CHANNEL, isChannel, normalizeOrigin } from "./origin.ts";

/**
 * Stamped at build time by both builders from one map, never from config or env:
 * a redirectable origin would make the check decorative.
 */
declare const __RELEASE_ORIGIN__: string;
declare const __RELEASE_KEYRING__: string;

const ORIGIN = typeof __RELEASE_ORIGIN__ === "string" ? __RELEASE_ORIGIN__ : "";
const KEYRING = typeof __RELEASE_KEYRING__ === "string" ? __RELEASE_KEYRING__ : "";

/** The release server this build was stamped with; undefined for a build from source. */
export function stampedOrigin(origin: string = ORIGIN): string | undefined {
  return normalizeOrigin(origin);
}

export interface ReleaseStamp {
  readonly origin: string;
  readonly channel: Channel;
  readonly keys: TrustedKeys;
}

/**
 * What this build resolves updates from; undefined for a source or unstamped build,
 * which has no signed channel to read. The parameters are for tests.
 */
export function releaseStamp(
  env: NodeJS.ProcessEnv = process.env,
  origin: string = ORIGIN,
  keyring: string = KEYRING,
): ReleaseStamp | undefined {
  const base = normalizeOrigin(origin);
  const keys = decodeTrustedKeys(keyring);
  if (base === undefined || keys === undefined) return undefined;
  return { origin: base, channel: channelFrom(env), keys };
}

/**
 * The one thing an install may choose, from a closed set: it picks which signed
 * document on the stamped host to read, never a host.
 */
function channelFrom(env: NodeJS.ProcessEnv): Channel {
  const requested = setting("RELEASE_CHANNEL", env);
  return requested !== undefined && isChannel(requested) ? requested : DEFAULT_CHANNEL;
}
