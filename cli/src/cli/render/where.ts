import type { Scope } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { locate } from "#engine/scope/locate.ts";

/** Outside a project a command that can uses your user scope, and says so after its result. */
export function noteUserScope(printer: Printer, asked: Scope | undefined, cwd: string): void {
  if (asked !== undefined || locate(undefined, cwd) !== undefined) return;
  printer.note("where", "your user scope, since this folder is not a project");
}
