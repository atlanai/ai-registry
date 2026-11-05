import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type Scope, scopeName } from "#core/store/paths.ts";

/** A manifest that does not read: one field's problem, which the caller prefixes with the file. */
export class ManifestError extends AiregError {
  constructor(message: string, hint?: string) {
    super(message, { code: ErrorCode.Invalid, hint });
    this.name = "ManifestError";
  }
}

/**
 * One failure for a registry a scope does not declare, wherever it is looked
 * up; `hint` replaces the default when the caller knows a better next step.
 */
export function unknownRegistry(
  alias: string,
  scope: Scope,
  known: Iterable<string>,
  hint?: string,
  /** Where it was looked for, when that was more than the scope. */
  searched = scopeName(scope),
): AiregError {
  const names = [...known].sort();
  const declare = `\`aireg registry add <address>${scope === "user" ? " -g" : ""}\``;
  return new AiregError(`No registry named ${quoted(alias)} in ${searched}.`, {
    code: ErrorCode.NotFound,
    hint:
      hint ??
      (names.length > 0
        ? `Use ${list(names, "or")}, or declare another with ${declare}.`
        : `Declare one first with ${declare}, such as github.com/owner/repo.`),
  });
}
