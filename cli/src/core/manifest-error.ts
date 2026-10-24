import { AiregError, ErrorCode } from "./errors.ts";

/** A manifest that does not read: one field's problem, which the caller prefixes with the file. */
export class ManifestError extends AiregError {
  constructor(message: string, hint?: string) {
    super(message, { code: ErrorCode.Invalid, hint });
    this.name = "ManifestError";
  }
}
