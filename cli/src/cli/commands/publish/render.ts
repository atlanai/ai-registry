import type { PublishResult } from "#adapter/index.ts";
import type { PublishReport } from "#cli/commands/publish/result.ts";
import type { Printer } from "#core/term/printer.ts";
import { changesJson } from "#engine/publish/changes.ts";
import type { Skipped } from "#engine/publish/exports.ts";
import type { Destination, Planned } from "#engine/publish/target.ts";
import { describeSkip, type Sending } from "./review.ts";

interface Outcome {
  dryRun: boolean;
  /** Absent when each artifact goes where it came from. */
  to: Destination | undefined;
  skipped: readonly Skipped[];
}

export function report(
  planned: Sending,
  results: ReadonlyMap<string, PublishResult | undefined>,
  outcome: Outcome,
): PublishReport {
  const { dryRun, to, skipped } = outcome;
  const target = to === undefined ? null : { registry: to.registry, namespace: to.namespace };
  const artifacts = planned.map(({ alias, item }) => {
    const result = results.get(alias);
    // `digest` leaves out the version, so two dry runs agree exactly when the content does.
    return {
      name: item.work.name,
      kind: item.work.kind,
      registry: alias,
      namespace: item.namespace,
      from: item.from ?? null,
      version: item.version,
      digest: item.input.contentId,
      belowLatest: item.belowLatest,
      published: !item.same && results.has(alias) && result?.unchanged !== true,
      dependsOn: (item.input.relationships ?? []).map(({ to }) => ({ to })),
      ...filesOf(item),
      ...changesJson(item.changes),
    };
  });
  return { dryRun, target, artifacts, skipped: [...skipped] };
}

function filesOf(item: Planned): { files?: string[] } {
  const { files } = item.input;
  return item.work.kind === "agent" && files.length > 1
    ? { files: files.map((file) => file.path) }
    : {};
}

/** The plan and each send were printed as they happened, so only an empty run is left to say. */
export function renderPublish(result: PublishReport, printer: Printer): void {
  if (result.artifacts.length > 0) return;
  printer.info(printer.style.dim("Nothing to publish."));
  const namespace = result.target?.namespace ?? "";
  for (const skip of result.skipped) printer.info(describeSkip(skip, namespace));
}
