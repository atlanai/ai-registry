import type { Trigger } from "#core/usage/model.ts";

/**
 * One run counted on this machine: which version ran, where and when, and nothing of the
 * conversation it ran in. `aireg usage` reads these, and a shared registry is sent its own.
 */
export interface Run {
  /** Stable for one artifact in one turn, so counting a session twice adds nothing. */
  id: string;
  /** ISO 8601. */
  at: string;
  /** The target that ran it, by its id. */
  target: string;
  trigger: Trigger;
  /** The registry's source key, as the lockfile records it. */
  registry: string;
  /** Its alias in the scope it was installed into, for messages. */
  alias: string;
  /** `<namespace>/<kind>/<name>@<version>`. */
  ref: string;
  /** The version's content digest, where the lockfile records one. */
  digest: string | undefined;
}

/** A registry some counted run came from: what sending needs to reach it again. */
export interface SeenRegistry {
  key: string;
  alias: string;
  location: string;
  adapter: string;
  config: Readonly<Record<string, string>>;
}
