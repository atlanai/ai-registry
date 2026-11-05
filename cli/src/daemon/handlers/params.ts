import { isAbsolute } from "node:path";
import { type Fields, isRecord } from "#adapter/fields.ts";
import type { Credential } from "#adapter/index.ts";
import { quoted } from "#adapter/text.ts";
import { type Job, STEP_POLICIES } from "#core/config/model.ts";
import { MINIMUM_INTERVAL_SECONDS, parseJob } from "#core/config/parse-job.ts";
import { readers } from "#core/fields.ts";
import { MAX_PAGE_SIZE } from "#core/run/store.ts";
import { SCOPES, type Scope } from "#core/store/paths.ts";
import { NOTHING, OPTIONAL_AXES, type SyncPolicy } from "#core/sync/policy.ts";
import { invalidParams } from "#daemon/rpc/errors.ts";

const fields = readers(invalidParams);

/** Local messages are untrusted input, so every field below is read, never trusted. */
export function object(value: unknown, what = "params"): Fields {
  return fields.record(value, what);
}

export const { flag, integer, oneOf, optionalFlag, optionalText, text } = fields;
const { choice } = fields;

/** An empty list is refused: it asks for a scoped run over nothing. */
export function optionalNames(entry: Fields, key: string): readonly string[] | undefined {
  if (entry[key] === undefined) return undefined;
  const value = names(entry, key);
  if (value.length === 0) throw invalidParams(`${key} must not be empty.`);
  return value;
}

function names(entry: Fields, key: string): readonly string[] {
  const value = fields.textList(entry[key], key);
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw invalidParams(`${key} names something more than once.`);
  return unique;
}

/** An empty list is refused; the caller checks each entry. */
export function list(entry: Fields, key: string): readonly unknown[] | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidParams(`${key} must be a list.`);
  if (value.length === 0) throw invalidParams(`${key} must not be empty.`);
  return value;
}

export function pageLimit<T extends number | undefined>(
  entry: Fields,
  key: string,
  fallback: T,
): number | T {
  if (entry[key] === undefined) return fallback;
  const limit = integer(entry, key);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw invalidParams(`The limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}

export function scope(entry: Fields, key: string, fallback: Scope): Scope {
  return choice(entry, key, SCOPES, fallback);
}

export function sourceConfig(entry: Fields, key: string): Record<string, string> {
  const raw = object(entry[key] ?? {}, key);
  return Object.fromEntries(Object.keys(raw).map((field) => [field, text(raw, field, key)]));
}

/** An OAuth sign-in's tokens, as `auth login` hands them over; never echoed back. */
export function oauthTokens(entry: Fields, key: string): Credential {
  const raw = object(entry[key], key);
  const refreshToken = optionalText(raw, "refreshToken", key);
  const expiresAtMs = raw.expiresAtMs === undefined ? undefined : integer(raw, "expiresAtMs", key);
  return {
    type: "bearer",
    accessToken: text(raw, "accessToken", key),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

const MAXIMUM_INTERVAL_SECONDS = 24 * 60 * 60;

export function intervalSeconds(entry: Fields, key: string, fallback: number) {
  return entry[key] === undefined ? fallback : interval(integer(entry, key));
}

/** A day at most: a job left longer reads as one that stopped. */
function interval(seconds: number): number {
  if (seconds < MINIMUM_INTERVAL_SECONDS || seconds > MAXIMUM_INTERVAL_SECONDS) {
    throw invalidParams(
      `The interval must be between ${MINIMUM_INTERVAL_SECONDS} and ${MAXIMUM_INTERVAL_SECONDS} seconds, not ${seconds}.`,
    );
  }
  return seconds;
}

export function syncPolicy(entry: Fields, key: string, fallback: SyncPolicy = NOTHING): SyncPolicy {
  const raw = object(entry[key] ?? {}, key);
  const policy: SyncPolicy = {
    pull: choice(raw, "pull", STEP_POLICIES, fallback.pull),
    publish: choice(raw, "publish", STEP_POLICIES, fallback.publish),
    delete: choice(raw, "delete", STEP_POLICIES, fallback.delete),
  };
  // Absent unless named, so a caller that does not know an axis gets the default.
  for (const axis of OPTIONAL_AXES) {
    if (raw[axis] === undefined && fallback[axis] === undefined) continue;
    policy[axis] = choice(raw, axis, STEP_POLICIES, fallback[axis] ?? "off");
  }
  return policy;
}

/** A relative root would resolve against the daemon's directory, not the caller's. */
export function absolutePath(entry: Fields, key: string): string {
  const value = text(entry, key);
  if (!isAbsolute(value)) throw invalidParams(`${key} must be an absolute path.`);
  return value;
}

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function jobId(entry: Fields, key: string): string {
  const value = text(entry, key);
  if (!JOB_ID.test(value)) {
    throw invalidParams(
      `A job id is 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit, not ${quoted(value)}.`,
    );
  }
  return value;
}

const JOB_FIELDS = ["id", "name", "account", "schedule", "steps"];

/** Held to config.yml's rules, so the daemon never stores a job it cannot read back. */
export function job(value: unknown): Job {
  const raw = object(value, "job");
  // A newer host may send fields this daemon does not know; drop them.
  const known = Object.fromEntries(Object.entries(raw).filter(([key]) => JOB_FIELDS.includes(key)));
  const steps = Array.isArray(raw.steps) ? raw.steps.map(flattened) : raw.steps;
  const parsed = parseJob({ ...known, steps }, "job", fields);
  jobId(raw, "id");
  interval(parsed.schedule.every);
  return parsed;
}

/** As config.yml holds it: the adapter's fields beside aireg's, not in a bag. */
function flattened(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { extra, ...rest } = value;
  return { ...object(extra ?? {}, "extra"), ...rest };
}
