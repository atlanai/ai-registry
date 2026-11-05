import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setting } from "#core/env.ts";

/** What a release build stamps in. Unstamped, the build refuses to update itself. */
export interface Stamps {
  version: string;
  origin: string;
  keyring: string;
  commit: string;
}

/** JSON-encoded so a value is never read as code. */
export function defines(stamps: Stamps): Record<string, string> {
  return {
    __VERSION__: JSON.stringify(stamps.version),
    __RELEASE_ORIGIN__: JSON.stringify(stamps.origin),
    __RELEASE_KEYRING__: JSON.stringify(stamps.keyring),
    __COMMIT__: JSON.stringify(stamps.commit),
  };
}

/** The npm build's stamps: the `AIREG_RELEASE_*` settings, by default package.json's version. */
export function releaseDefines(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  const { version } = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  return defines({
    version: setting("RELEASE_VERSION", env) ?? version,
    origin: setting("RELEASE_ORIGIN", env) ?? "",
    keyring: setting("RELEASE_KEYRING", env) ?? "",
    commit: setting("RELEASE_COMMIT", env) ?? "",
  });
}
