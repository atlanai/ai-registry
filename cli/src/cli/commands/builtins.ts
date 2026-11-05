import { quoted } from "#adapter/text.ts";
import { ADAPTER_COMMAND } from "#cli/commands/adapter/spec.ts";
import { ADD_COMMAND } from "#cli/commands/add/spec.ts";
import { AUTH_COMMAND } from "#cli/commands/auth/spec.ts";
import { CONFIG_COMMAND } from "#cli/commands/config/spec.ts";
import { CONSOLE_COMMAND } from "#cli/commands/console/spec.ts";
import { DAEMON_COMMAND } from "#cli/commands/daemon/spec.ts";
import { DOCTOR_COMMAND } from "#cli/commands/doctor/spec.ts";
import { INIT_COMMAND } from "#cli/commands/init/spec.ts";
import { INSTALL_COMMAND } from "#cli/commands/install/spec.ts";
import { JOB_COMMAND } from "#cli/commands/job/spec.ts";
import { LIST_COMMAND } from "#cli/commands/list/spec.ts";
import { LOGS_COMMAND } from "#cli/commands/logs/spec.ts";
import { OUTDATED_COMMAND } from "#cli/commands/outdated/spec.ts";
import { PUBLISH_COMMAND } from "#cli/commands/publish/spec.ts";
import { REGISTRY_COMMAND } from "#cli/commands/registry/spec.ts";
import { REMOVE_COMMAND } from "#cli/commands/remove/spec.ts";
import { SEARCH_COMMAND } from "#cli/commands/search/spec.ts";
import { SELF_COMMAND } from "#cli/commands/self/spec.ts";
import { SHOW_COMMAND } from "#cli/commands/show/spec.ts";
import { STATUS_COMMAND } from "#cli/commands/status/spec.ts";
import { SYNC_COMMAND } from "#cli/commands/sync/spec.ts";
import { TARGETS_COMMAND } from "#cli/commands/targets/spec.ts";
import { UNLOCK_COMMAND } from "#cli/commands/unlock/spec.ts";
import { UPDATE_COMMAND } from "#cli/commands/update/spec.ts";
import { WATCH_COMMAND } from "#cli/commands/watch/spec.ts";
import type { Printer } from "#core/term/printer.ts";
import type { CommandSpec } from "./command.ts";

/** In the order `--help` lists each group. */
export const BUILTIN_SPECS: readonly CommandSpec[] = [
  INIT_COMMAND,
  REGISTRY_COMMAND,
  AUTH_COMMAND,
  SEARCH_COMMAND,
  ADD_COMMAND,
  REMOVE_COMMAND,
  INSTALL_COMMAND,
  UPDATE_COMMAND,
  SHOW_COMMAND,
  CONSOLE_COMMAND,
  STATUS_COMMAND,
  LIST_COMMAND,
  OUTDATED_COMMAND,
  TARGETS_COMMAND,
  SYNC_COMMAND,
  PUBLISH_COMMAND,
  WATCH_COMMAND,
  JOB_COMMAND,
  DAEMON_COMMAND,
  CONFIG_COMMAND,
  DOCTOR_COMMAND,
  UNLOCK_COMMAND,
  ADAPTER_COMMAND,
  LOGS_COMMAND,
  SELF_COMMAND,
];

/** A kind or an adapter's command cannot take these names. */
export const RESERVED: ReadonlySet<string> = new Set([
  "help",
  ...BUILTIN_SPECS.flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.formerly ?? [])]),
]);

export interface Hidden {
  readonly name: string;
  readonly message: string;
  readonly hint: string;
}

export const PRECEDENCE = "aireg's own commands come first.";

export function hiddenKind(name: string): Hidden {
  return {
    name,
    message: `The kind ${quoted(name)} has the same name as a command, so \`aireg ${name}\` runs the command.`,
    hint: `Rename the kind in registry.json, since ${PRECEDENCE}`,
  };
}

export function printHidden(printer: Printer, hidden: readonly Hidden[]): void {
  for (const entry of hidden) printer.warning(entry.message);
  for (const hint of new Set(hidden.map((entry) => entry.hint))) printer.hint(hint);
}
