import { plural } from "#adapter/text.ts";
import { action } from "#cli/commands/define.ts";
import type { DeclaredRegistry, RegistryList } from "#cli/commands/registry/result.ts";
import { formatRef } from "#core/ref.ts";
import { scopeName } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { load } from "#engine/scope/load.ts";
import type { Options } from "./options.ts";
import { described } from "./shared.ts";

interface Listed {
  data: RegistryList;
  installs: ReadonlyMap<string, string[]>;
}

export const list = action({
  async run({ common }: Options, context): Promise<Listed> {
    const loaded = await load(common, context.cwd, "user");
    const installs = new Map<string, string[]>();
    for (const ref of loaded.manifest.artifacts) {
      installs.set(ref.registry, [...(installs.get(ref.registry) ?? []), formatRef(ref)]);
    }
    return {
      data: {
        scope: loaded.roots.scope,
        registries: Object.entries(loaded.manifest.registries).map(([alias, source]) =>
          described(alias, source),
        ),
      },
      installs,
    };
  },
  data: (result) => result.data,
  text({ data, installs }, printer) {
    const { registries } = data;
    if (registries.length === 0) {
      printer.info(`No registries declared in ${scopeName(data.scope)}.`);
      printer.hint("Run `aireg registry add <address>` to add one.");
      return;
    }
    const style = printer.style;
    printer.info(
      style.bold(
        `${plural(registries.length, "registry", "registries")} in ${scopeName(data.scope)}`,
      ),
    );
    table(
      printer,
      [
        { header: "name", value: (entry: DeclaredRegistry) => entry.registry },
        { header: "address", value: (entry: DeclaredRegistry) => entry.address },
        {
          header: "ref",
          value: (entry: DeclaredRegistry) => entry.config.ref ?? "",
          optional: true,
        },
        {
          header: "path",
          value: (entry: DeclaredRegistry) => entry.config.path ?? "",
          optional: true,
        },
        {
          header: "adapter",
          value: (entry: DeclaredRegistry) => style.dim(entry.adapter ?? ""),
          optional: true,
        },
        {
          header: "installs",
          value: (entry: DeclaredRegistry) => {
            const refs = installs.get(entry.registry) ?? [];
            return refs.length === 0 ? style.dim("nothing") : refs.join(", ");
          },
        },
      ],
      registries,
    );
  },
});
