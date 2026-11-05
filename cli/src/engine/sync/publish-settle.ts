import { isAdapterError } from "#adapter/index.ts";
import { failureCode, type ItemOutcome, RunErrorCode } from "#core/run/model.ts";
import type { SyncExecutionHooks, SyncOutcome } from "./decide.ts";

export interface PublishTally {
  /** Staged and handed to the adapter. */
  attempted: ReadonlySet<string>;
  published: ReadonlySet<string>;
  archived?: ReadonlySet<string>;
  refusals: ReadonlyMap<string, unknown>;
  /** Already held by the source and not live yet, with why. */
  holds?: ReadonlyMap<string, string>;
}

// Each publish settles once known; one the rebased plan did not send, or the source holds,
// needs a person.
export function settlePublished(
  deferred: readonly SyncOutcome[],
  tally: PublishTally,
  batchError: unknown,
  hooks: SyncExecutionHooks,
): void {
  for (const item of deferred) {
    const reason = tally.holds?.get(item.artifact);
    if (reason !== undefined) {
      hooks.item(
        item.artifact,
        "publishing",
        {
          outcome: "attention",
          kind: item.kind,
          disposition: item.disposition,
          operation: item.operation,
          errorCode: RunErrorCode.InReview,
          retryable: false,
        },
        { detail: reason },
      );
      continue;
    }
    const landed =
      tally.published.has(item.artifact) || tally.archived?.has(item.artifact) === true;
    const error = tally.refusals.has(item.artifact)
      ? tally.refusals.get(item.artifact)
      : attemptedError(tally, item.artifact, batchError);
    const failed = !landed && error !== undefined;
    // A code alone cannot say why the registry refused this one; the adapter's message can.
    hooks.item(
      item.artifact,
      item.operation === "archive" ? "archiving" : "publishing",
      {
        outcome: settledOutcome(landed, failed),
        kind: item.kind,
        disposition: item.disposition,
        operation: item.operation,
        ...(failed ? failureCode(error) : {}),
      },
      failed && isAdapterError(error) ? { detail: error.message } : undefined,
    );
  }
}

function attemptedError(tally: PublishTally, artifact: string, batchError: unknown): unknown {
  return tally.attempted.has(artifact) ? batchError : undefined;
}

function settledOutcome(landed: boolean, failed: boolean): ItemOutcome {
  if (landed) return "changed";
  return failed ? "failed" : "attention";
}
