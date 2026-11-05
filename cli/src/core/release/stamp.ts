import { setting } from "#core/env.ts";
import { decodeTrustedKeys, type TrustedKeys } from "./keyring.ts";
import { type Channel, DEFAULT_CHANNEL, isChannel, normalizeOrigin } from "./origin.ts";

/** Stamped at build time, never from config or env: a redirectable origin defeats the check. */
declare const __RELEASE_ORIGIN__: string;
declare const __RELEASE_KEYRING__: string;

const ORIGIN = typeof __RELEASE_ORIGIN__ === "string" ? __RELEASE_ORIGIN__ : "";
const KEYRING = typeof __RELEASE_KEYRING__ === "string" ? __RELEASE_KEYRING__ : "";

/** The release server this build was stamped with; undefined for a build from source. */
export function stampedOrigin(): string | undefined {
  return normalizeOrigin(ORIGIN);
}

export interface ReleaseStamp {
  readonly origin: string;
  readonly channel: Channel;
  readonly keys: TrustedKeys;
}

/** Undefined for a source or unstamped build. The parameters are for tests. */
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

/** An install may pick which signed document on the stamped host to read, never a host. */
function channelFrom(env: NodeJS.ProcessEnv): Channel {
  const requested = setting("RELEASE_CHANNEL", env);
  return requested !== undefined && isChannel(requested) ? requested : DEFAULT_CHANNEL;
}
