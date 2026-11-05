import { list } from "#adapter/text.ts";
import { type Bumped, printBumped, version } from "#cli/commands/kind/bump.ts";
import { type Created, init, printCreated } from "#cli/commands/kind/new.ts";
import { type Copied, newFrom, printCopied } from "#cli/commands/kind/new-from.ts";
import type { KindBump, KindNewResult } from "#cli/commands/kind/result.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import type { KindManifest } from "#core/filespec/kind-manifests.ts";
import type { CommandContext, CommandSpec } from "./command.ts";
import { action, defineCommand, type STREAMED } from "./define.ts";

export interface Own extends Record<string, unknown> {
  namespace?: string;
  file?: string;
  set?: string[];
  name?: string;
  from?: string[];
}

interface Options {
  argument: string | undefined;
  extra: string | undefined;
  /** A shell glob after --from lands here as more paths. */
  words: string[];
  own: Own;
  yes: boolean;
}

/** `aireg <kind> <action>`: one set of verbs for every kind a registry holds. */
export function runKind(
  spec: CommandSpec,
  manifest: KindManifest,
  context: CommandContext,
): Promise<void> {
  const kind = spec.name;
  return defineCommand<Options>({
    spec,
    parse(argv) {
      const { positionals, own, common } = parse<Own>(argv, spec);
      const [verb, argument, extra] = positionals;
      if (verb === undefined) {
        const actions = (spec.actions ?? []).map((a) => a.name);
        throw needsInput(kind, "an action", `Use ${list(actions, "or")}.`);
      }
      return {
        action: verb,
        options: { argument, extra, words: positionals.slice(1), own, yes: common.yes },
      };
    },
    actions: {
      new: action({
        run: ({ argument, words, own, yes }, at): Promise<Created | Copied | typeof STREAMED> =>
          own.from === undefined
            ? init(kind, manifest, at, argument, own, yes)
            : newFrom(kind, manifest, at, [...own.from, ...words], own, yes),
        text: (result, printer) =>
          "shown" in result ? printCopied(result, printer) : printCreated(result, printer),
        data: (result): KindNewResult =>
          "shown" in result
            ? { kind: result.kind, namespace: result.namespace, created: result.created }
            : { kind: result.kind, name: result.name, created: result.created, todo: result.todo },
      }),
      bump: action({
        run: ({ argument, extra, own }, at): Promise<Bumped> =>
          version(kind, at, argument, extra, own),
        text: printBumped,
        data: ({ kind: named, name, from, to }): KindBump => ({ kind: named, name, from, to }),
      }),
    },
  }).run(context);
}
