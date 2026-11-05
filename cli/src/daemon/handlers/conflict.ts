import { quoted } from "#adapter/text.ts";
import type { Account } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import type { RunRecord } from "#core/run/model.ts";
import type { Disposition } from "#core/sync/model.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import { invalidParams } from "#daemon/rpc/errors.ts";
import type { ConflictResolution, RpcContext } from "#daemon/rpc/methods.ts";
import type { SyncRunner } from "#daemon/runs/runner.ts";
import { artifactKey } from "#engine/sync/decide.ts";
import { kindAddress } from "#engine/sync/narrow.ts";
import { watchStatus } from "#engine/sync/status.ts";
import { jobOfWork, type ScopeWork, workOf } from "#engine/sync/work.ts";
import { accountOf, artifactsJobFor } from "./job.ts";
import * as inputs from "./params.ts";

/** The editor owns the content, so `mine` becomes the next version rather than a side copy. */
const RESOLUTION_OPERATION: Record<ConflictResolution, SyncOperation> = {
  mine: "publish",
  theirs: "pull",
};

const RESOLUTIONS = Object.keys(RESOLUTION_OPERATION) as ConflictResolution[];

/** `theirs` replaces whatever differs here; `mine` needs an edit here to publish. */
export function resolvable(
  artifact: { operation: string; disposition: Disposition } | undefined,
  wanted: ConflictResolution,
): boolean {
  if (artifact === undefined) return false;
  if (artifact.operation === "attention") return true;
  return wanted === "theirs"
    ? TAKEABLE.includes(artifact.disposition)
    : artifact.disposition === "publish";
}

const TAKEABLE: readonly Disposition[] = ["publish", "conflict", "archive", "pull", "pull-delete"];

/** An ordinary run over one artifact, so a client follows it as it follows a sync. */
export async function startResolution(
  runner: SyncRunner,
  params: Record<string, unknown>,
  work: ScopeWork,
  account: Account,
  options: { signal: AbortSignal; place: string; ephemeral?: boolean },
): Promise<{ run: RunRecord }> {
  const name = inputs.text(params, "name");
  const wanted = inputs.oneOf(params, "resolution", RESOLUTIONS);
  // Refused rather than start a run that would silently do nothing.
  if (wanted === "theirs" && work.policy.pull === "off") {
    throw invalidParams(
      `The registry's copy cannot be taken ${options.place}, because pulling is off.`,
    );
  }

  const status = await watchStatus(work, account, options.signal);
  const artifact = status.artifacts.find((entry) => entry.name === name);
  if (artifact === undefined || !resolvable(artifact, wanted)) {
    // Tell an unknown name from an artifact that already settled.
    throw invalidParams(
      artifact === undefined
        ? `No artifact named ${quoted(name)} ${options.place}.`
        : `${quoted(name)} is not waiting on a choice ${options.place}, so there is nothing to resolve.`,
    );
  }

  // A skill and an agent may share the name; settle only the kind waiting on the choice.
  const overrides = new Map([[artifactKey(artifact.kind, name), RESOLUTION_OPERATION[wanted]]]);
  return {
    run: await runner.start(work.id, "sync", "manual", {
      refs: [kindAddress(account.registry, artifact.kind, name)],
      overrides,
      ...(options.ephemeral === true ? { ephemeral: { job: jobOfWork(work), account } } : {}),
    }),
  };
}

export async function resolveConflict(
  raw: unknown,
  context: RpcContext,
  runner: SyncRunner,
): Promise<{ run: RunRecord }> {
  const params = inputs.object(raw);
  const config = await readConfig();
  const job = artifactsJobFor(config, inputs.text(params, "jobId"));
  return startResolution(runner, params, workOf(job), accountOf(config, job), {
    signal: context.signal,
    place: `in job ${quoted(job.id)}`,
  });
}
