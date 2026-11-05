import type { PublishResult } from "#adapter/index.ts";
import type { Printer } from "#core/term/printer.ts";
import { changesJson } from "#engine/publish/changes.ts";
import type { Skipped } from "#engine/publish/exports.ts";
import type { Destination, Planned } from "#engine/publish/target.ts";
import { describeSkip, type Sending } from "./review.ts";

/** What `--json` says beside each artifact: whether anything was sent, where, and what was left out. */
interface Outcome {
  dryRun: boolean;
  /** Where exports go, from `--to` or `publish.to`; absent when each artifact goes where it came from. */
  to: Destination | undefined;
  skipped: readonly Skipped[];
}

/** Prints the `--json` result; does nothing in other formats. */
export function report(
  printer: Printer,
  planned: Sending,
  results: ReadonlyMap<string, PublishResult | undefined>,
  outcome: Outcome,
): void {
  if (printer.format !== "json") return;
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
  printer.json({ ok: true, data: { dryRun, target, artifacts, skipped } });
}

function filesOf(item: Planned): { files?: string[] } {
  const { files } = item.input;
  return item.work.kind === "agent" && files.length > 1
    ? { files: files.map((file) => file.path) }
    : {};
}

export function nothing(printer: Printer, outcome: Outcome): void {
  printer.info(printer.style.dim("Nothing to publish."));
  for (const skip of outcome.skipped) printer.info(describeSkip(skip, outcome.to?.namespace ?? ""));
  report(printer, [], new Map(), outcome);
}
