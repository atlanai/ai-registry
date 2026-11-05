import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode, type ErrorOptions } from "#core/errors.ts";
import { type Scope, scopeFlag, scopeName } from "#core/store/paths.ts";

/** A manifest that does not read: one field's problem, which the caller prefixes with the file. */
export class ManifestError extends AiregError {
  constructor(message: string, options: Pick<ErrorOptions, "hint"> = {}) {
    super(message, { code: ErrorCode.Invalid, hint: options.hint });
    this.name = "ManifestError";
  }
}

interface UnknownRegistryOptions {
  /** Replaces the default when the caller knows a better next step. */
  hint?: string | undefined;
  /** Where it was looked for, when that was more than the scope. */
  searched?: string;
}

/** One failure for a registry a scope does not declare, wherever it is looked up. */
export function unknownRegistry(
  alias: string,
  scope: Scope,
  known: Iterable<string>,
  options: UnknownRegistryOptions = {},
): AiregError {
  const names = [...known].sort();
  const declare = `\`aireg registry add <address>${scopeFlag(scope)}\``;
  const searched = options.searched ?? scopeName(scope);
  return new AiregError(`No registry named ${quoted(alias)} in ${searched}.`, {
    code: ErrorCode.NotFound,
    hint:
      options.hint ??
      (names.length > 0
        ? `Use ${list(names, "or")}, or declare another with ${declare}.`
        : `Declare one first with ${declare}, such as github.com/owner/repo.`),
  });
}
