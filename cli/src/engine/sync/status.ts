import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Account } from "#core/config/model.ts";
import { type Candidate, displayPath } from "#core/sync/adopt.ts";
import type { Disposition } from "#core/sync/model.ts";
import { operation, type SyncOperation } from "#core/sync/policy.ts";
import { selectTargets } from "#engine/install/targets.ts";
import { inspect } from "./inspect.ts";
import { closeScan } from "./scan.ts";
import type { ScopeWork } from "./work.ts";

interface WatchArtifactStatus {
  name: string;
  kind: ArtifactKind;
  /** Path inside the registry, POSIX separators. */
  path: string;
  disposition: Disposition;
  operation: SyncOperation;
  detail: string | undefined;
}

/** Work found in the project that no registry entry accounts for yet. */
interface WatchLocalArtifact {
  name: string;
  kind: ArtifactKind;
  path: string;
  target: string;
}

export interface WatchStatus {
  jobId: string;
  checkedAtMs: number;
  artifacts: WatchArtifactStatus[];
  local: WatchLocalArtifact[];
  undeclared: WatchLocalArtifact[];
  targets: string[];
}

/** What a job would do right now, reported without writing anything. */
export async function watchStatus(
  job: ScopeWork,
  account: Account,
  signal: AbortSignal,
): Promise<WatchStatus> {
  const { loaded, common, found } = await inspect(job, account, signal);
  // Status is asked for often, so the sources its scan opened are closed at once.
  await closeScan(found);
  const place = (item: Candidate): WatchLocalArtifact => ({
    name: item.name,
    kind: item.kind,
    path: displayPath(loaded.roots, item.from),
    target: item.target,
  });

  return {
    jobId: job.id,
    checkedAtMs: Date.now(),
    artifacts: found.items
      .filter((item) => item.source === account.registry)
      .map((item) => ({
        name: item.name,
        kind: item.kind,
        path: item.path,
        disposition: item.disposition,
        operation: operation(item.disposition, job.policy),
        detail: item.detail,
      })),
    local: found.local.map(place),
    undeclared: found.undeclared.map(place),
    targets: selectTargets(loaded.manifest, loaded.targetTable, common),
  };
}
