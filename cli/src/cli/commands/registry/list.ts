import { plural, withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { formatRef } from "#core/ref.ts";
import { scopeName } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { described } from "./shared.ts";

export async function list(context: CommandContext, common: CommonOptions): Promise<void> {
  const loaded = await load(common, context.cwd, "user");
  const entries = Object.entries(loaded.manifest.registries);

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        scope: loaded.roots.scope,
        registries: entries.map(([alias, source]) => described(alias, source)),
      },
    });
    return;
  }
  if (entries.length === 0) {
    context.printer.info(`No registries declared in ${scopeName(loaded.roots.scope)}.`);
    context.printer.hint("Run `aireg registry add <address>` to add one.");
    return;
  }

  // What each alias installs, so the list answers "why is this here" too.
  const used = new Map<string, string[]>();
  for (const ref of loaded.manifest.artifacts) {
    used.set(ref.registry, [...(used.get(ref.registry) ?? []), formatRef(ref)]);
  }

  const style = context.printer.style;
  context.printer.info(
    style.bold(
      `${plural(entries.length, "registry", "registries")} in ${scopeName(loaded.roots.scope)}`,
    ),
  );
  table(
    context.printer,
    [
      { header: "name", value: ([alias]) => alias },
      { header: "address", value: ([, source]) => withoutCredentials(source.location) },
      { header: "ref", value: ([, source]) => source.config.ref ?? "", optional: true },
      { header: "path", value: ([, source]) => source.config.path ?? "", optional: true },
      { header: "adapter", value: ([, source]) => style.dim(source.adapter ?? ""), optional: true },
      {
        header: "installs",
        value: ([alias]) => {
          const refs = used.get(alias) ?? [];
          return refs.length === 0 ? style.dim("nothing") : refs.join(", ");
        },
      },
    ],
    entries,
  );
}
