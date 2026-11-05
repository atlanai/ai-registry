import { ConfigConflictError } from "#core/config/errors.ts";
import { staleSettings } from "#daemon/rpc/errors.ts";

/** A stale snapshot is normal with two clients, so it gets its own code and the revision. */
export async function committed<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ConfigConflictError)) throw error;
    throw staleSettings(error.currentRevision);
  }
}
