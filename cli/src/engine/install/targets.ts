import { basename } from "node:path";
import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Manifest } from "#core/manifest/model.ts";
import type { Targets } from "#core/target/contract.ts";
import { DEFAULT_TARGETS, names } from "#core/target/ids.ts";
import { loadTargetFiles } from "#core/target/load.ts";
import type { CommonOptions } from "#engine/options.ts";

/** Explicit flag wins, then the manifest, then `DEFAULT_TARGETS`. */
export function selectTargets(
  manifest: Manifest,
  targetTable: Targets,
  common: CommonOptions,
): string[] {
  const wanted = common.targets ?? (manifest.targets.length > 0 ? manifest.targets : undefined);
  if (wanted === undefined) return [...DEFAULT_TARGETS];
  if (wanted.includes("*")) return names(targetTable);

  const known = new Set(names(targetTable));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    // From --for it is the command line; from the manifest it is file content.
    // A file of yours that would define one, but was skipped, is the likelier story.
    const skipped = loadTargetFiles().skipped.filter((file) =>
      unknown.some((name) => basename(file.path) === `${name}.json`),
    );
    throw new AiregError(`No target named ${list(unknown.map(quoted), "or")}.`, {
      code: common.targets === undefined ? ErrorCode.Invalid : ErrorCode.Usage,
      hint:
        skipped.length > 0
          ? `aireg skipped ${list(skipped.map((file) => file.path))}: run \`aireg targets\` to see why.`
          : `Use ${list(names(targetTable), "or")}, or run \`aireg targets\` to see which this machine has.`,
    });
  }
  return wanted;
}
