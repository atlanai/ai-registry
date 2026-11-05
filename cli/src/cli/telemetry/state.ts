import { readConfig } from "#core/config/repository.ts";
import { envName, present, setting } from "#core/env.ts";
import { TELEMETRY_PATH } from "#core/product.ts";
import { stampedOrigin } from "#core/release/stamp.ts";

const OFF_SWITCHES = ["DO_NOT_TRACK", envName("DISABLE_TELEMETRY")];

export type TelemetryState =
  | { on: true; url: string }
  | { on: false; why: "opted-out"; switch: string }
  | { on: false; why: "config" }
  | { on: false; why: "source-build" };

export function telemetryState(
  env: NodeJS.ProcessEnv = process.env,
  origin: string | undefined = stampedOrigin(),
  saved = true,
): TelemetryState {
  const off = OFF_SWITCHES.find((name) => present(name, env));
  if (off !== undefined) return { on: false, why: "opted-out", switch: off };
  if (!saved) return { on: false, why: "config" };
  const url =
    setting("TELEMETRY_URL", env) ?? (origin === undefined ? undefined : origin + TELEMETRY_PATH);
  return url === undefined ? { on: false, why: "source-build" } : { on: true, url };
}

/** With the saved `telemetry` setting read; a config that cannot be read sends nothing. */
export async function savedTelemetryState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryState> {
  const saved = await readConfig(env).then(
    (config) => config.telemetry,
    () => false,
  );
  return telemetryState(env, stampedOrigin(), saved);
}
