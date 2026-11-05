import { ConfigConflictError } from "#core/config/errors.ts";
import { staleSettings } from "#daemon/rpc/errors.ts";

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
