import { list } from "#adapter/text.ts";
import { needsInput } from "#cli/options/parse.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { multiselect } from "#cli/prompt/multiselect.ts";
import type { Export } from "#core/manifest/model.ts";
import { displayPath } from "#core/sync/adopt.ts";
import type { Printer } from "#core/term/printer.ts";
import type { CommonOptions } from "#engine/options.ts";
import { exportWork } from "#engine/publish/exports.ts";
import { exportsOn, installedPaths } from "#engine/publish/reach.ts";
import { changedSince, type Exported, edited, fromArgs, type Work } from "#engine/publish/work.ts";
import type { Loaded } from "#engine/scope/load.ts";

export async function gather(
  step: Interaction,
  loaded: Loaded,
  common: CommonOptions,
  cwd: string,
  options: {
    paths: readonly string[];
    since: string | undefined;
    found: ReadonlyMap<string, Export> | undefined;
    to: string | undefined;
  },
): Promise<Work[] | undefined> {
  const { paths, since, found, to } = options;
  const keep = async (works: Work[]) =>
    since === undefined ? works : changedSince(works, since, cwd);

  const exported = found === undefined ? undefined : await exportWork(found, loaded.roots.base);
  let works: Work[] | undefined;
  // A hint naming another path runs as printed: same destination and dry run.
  const again = [
    ...(to === undefined ? [] : ["--to", to]),
    ...(common.dryRun ? ["--dry-run"] : []),
  ];
  if (paths.length > 0) works = await keep(await fromArgs(paths, loaded, cwd, again));
  else if (exported !== undefined) works = await keep(exported);
  else works = await chooseWork(step, loaded, common, cwd, keep);
  for (const work of works ?? []) work.exported = found?.get(work.path);
  return works;
}

/** With nothing named, the work edited here: all of it under `--yes`, a pick on a terminal. */
async function chooseWork(
  step: Interaction,
  loaded: Loaded,
  common: CommonOptions,
  cwd: string,
  keep: (found: Work[]) => Promise<Work[]>,
) {
  const { works, differing } = await edited(loaded, common, cwd);
  const copies = new Map<string, string[]>();
  for (const { name, from } of differing) {
    copies.set(name, [...(copies.get(name) ?? []), displayPath(loaded.roots, from)]);
  }
  for (const [name, paths] of copies) {
    step.printer.warning(
      `${paths.length} different ${name} skills, so none was taken: ${paths.join(", ")}.`,
    );
  }
  if (differing.length > 0)
    step.printer.hint("Run `aireg publish <path>` to publish the one you mean.");
  const found = await keep(works);
  // A dry run sends nothing, so listing everything is the answer to "what would go".
  if (found.length === 0 || common.yes || common.dryRun) return found;
  if (!interactive(step)) {
    throw needsInput(
      "publish",
      "a path or an artifact name",
      `Name one, or pass \`--yes\` to publish everything edited here: ${list(found.map((w) => w.name))}.`,
    );
  }
  const picked = await multiselect(
    {
      message: "What should be published?",
      style: step.printer.errStyle,
      choices: found.map((work, index) => ({
        value: String(index),
        label: work.name,
        hint: work.home === undefined ? `${work.kind}, new` : `${work.kind}, edited here`,
      })),
      required: true,
    },
    step.io,
  );
  return canceled(picked) ? undefined : picked.map((index) => found[Number(index)] as Work);
}

export async function reachExports(
  loaded: Loaded,
  printer: Printer,
): Promise<Map<string, Exported> | undefined> {
  const { manifest, roots, lock } = loaded;
  if (manifest.exports.length === 0) return undefined;
  const reached = await exportsOn(manifest, roots.base, installedPaths(lock, roots.base));
  for (const note of reached.notes) printer.info(note);
  for (const warning of reached.warnings) printer.warning(warning);
  return reached.found;
}
