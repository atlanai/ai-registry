import { envName } from "#core/env.ts";
import { HOME_DIR, NAME } from "#core/product.ts";

/** Moving the `cli/current` symlink is what goes live. */
export function standaloneShim(): string {
  return `#!/bin/sh
set -eu
ROOT="\${${envName("HOME")}:-$HOME/${HOME_DIR}}"
BIN="$ROOT/cli/current/${NAME}"
if [ ! -x "$BIN" ]; then
  echo "${NAME}: installed CLI is missing; re-run the installer." >&2
  exit 1
fi
exec "$BIN" "$@"
`;
}
