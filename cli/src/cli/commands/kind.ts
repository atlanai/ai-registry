import { list } from "#adapter/text.ts";
import { version } from "#cli/commands/kind/bump.ts";
import { init } from "#cli/commands/kind/new.ts";
import { newFrom } from "#cli/commands/kind/new-from.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import type { KindManifest } from "#core/filespec/kind-manifests.ts";
import { type CommandContext, type CommandSpec, runAction } from "./command.ts";

export interface Own extends Record<string, unknown> {
  namespace?: string;
  file?: string;
  set?: string[];
  name?: string;
  from?: string[];
}

/** `aireg <kind> <action>`: one set of verbs for every kind a registry holds. */
export async function runKind(
  spec: CommandSpec,
  manifest: KindManifest,
  context: CommandContext,
): Promise<void> {
  const kind = spec.name;
  const { positionals, own, common } = parse<Own>(context.argv, spec);
  const [action, argument, extra] = positionals;
  if (action === undefined) {
    const actions = (spec.actions ?? []).map((a) => a.name);
    throw needsInput(kind, "an action", `Use ${list(actions, "or")}.`);
  }
  // A shell glob after --from lands as more positionals, so `new` takes them as more paths.
  return runAction(spec, action, {
    new: () =>
      own.from === undefined
        ? init(kind, manifest, context, argument, own, common.yes)
        : newFrom(kind, manifest, context, [...own.from, ...positionals.slice(1)], own, common.yes),
    bump: () => version(kind, context, argument, extra, own),
  });
}
