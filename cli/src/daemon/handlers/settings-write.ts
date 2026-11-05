import { ConfigConflictError } from "#core/config/errors.ts";
import { RpcErrorCode } from "#daemon/rpc/codes.ts";
import { ProtocolError } from "#daemon/rpc/protocol.ts";

/** Two clients editing jobs is normal, so a stale snapshot gets its own code and
 * the revision to resync from, not an internal error. */
export async function committed<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ConfigConflictError)) throw error;
    throw staleSettings(error.currentRevision);
  }
}

/** The caller retries on the code; the words are for when its retries run out. */
export function staleSettings(revision: number): ProtocolError {
  return new ProtocolError(
    RpcErrorCode.StaleRevision,
    "The settings changed while this command ran. Run it again.",
    { revision },
  );
}
