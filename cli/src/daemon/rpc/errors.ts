import { adapterProblem, messageOf } from "#adapter/errors.ts";
import { isAdapterError } from "#adapter/index.ts";
import { ConfigConflictError } from "#core/config/errors.ts";
import { CredentialStoreError } from "#core/credentials/store.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { staleSettings } from "#daemon/handlers/settings-write.ts";
import { RpcErrorCode } from "./codes.ts";
import { ProtocolError } from "./protocol.ts";

/** Classified failures stay named on the socket, with their code; a raw throw is internal. */
export function rpcError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  const adapter = isAdapterError(error)
    ? error
    : error instanceof Error && isAdapterError(error.cause)
      ? error.cause
      : undefined;
  if (adapter !== undefined) {
    return new ProtocolError(RpcErrorCode.Server, messageOf(error), adapterProblem(adapter));
  }
  // Another writer moved the config first: the caller resyncs and retries.
  if (error instanceof ConfigConflictError) {
    return staleSettings(error.currentRevision);
  }
  // The machine's problem, with one fix, so it is named rather than called internal.
  if (diskFull(error)) {
    return new ProtocolError(
      RpcErrorCode.Server,
      `No space is left on the disk that holds aireg's state. Free some space, then run the command again.`,
    );
  }
  if (error instanceof AiregError) {
    const detail = error instanceof CredentialStoreError ? reason(error) : undefined;
    const message = detail ? `${error.message.replace(/\.$/, "")}: ${detail}` : error.message;
    return new ProtocolError(rpcCodeFor(error.code), message, {
      code: error.code,
      title: message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }
  return new ProtocolError(
    RpcErrorCode.Internal,
    `The aireg daemon hit an unexpected error. Run \`aireg logs --daemon\` to see it.`,
  );
}

/** SQLite's primary result code for a full disk, in the low byte of an extended code. */
const SQLITE_FULL = 13;

function diskFull(error: unknown): boolean {
  const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
  if (code === "ENOSPC") return true;
  return (
    code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && (errcode & 0xff) === SQLITE_FULL
  );
}

function reason(error: Error): string | undefined {
  const cause = error.cause;
  return cause instanceof Error ? (cause.message.split("\n")[0] ?? cause.message) : undefined;
}

function rpcCodeFor(code: ErrorCode): RpcErrorCode {
  if (code === ErrorCode.NotFound) return RpcErrorCode.NotFound;
  if (code === ErrorCode.Usage || code === ErrorCode.Invalid) return RpcErrorCode.InvalidParams;
  return RpcErrorCode.Server;
}
