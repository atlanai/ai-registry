import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import { list as listOf, withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { action } from "#cli/commands/define.ts";
import type { PublishedArtifact, RegistryShown } from "#cli/commands/registry/result.ts";
import { needsInput } from "#cli/options/parse.ts";
import { underHome } from "#cli/render/home.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { findRegistry } from "#core/filespec/init.ts";
import { abbreviate } from "#core/term/printer.ts";
import { fields, table } from "#core/term/table.ts";
import { probe, throughManifest } from "#engine/address/probe.ts";
import { knownRegistries, undeclaredRegistry } from "#engine/address/registries.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import type { Options } from "./options.ts";

export const show = action({
  async run({ argument: input, flags, common }: Options, context): Promise<RegistryShown> {
    const target = input ?? (await onlyDeclared(context, common));
    const known = await knownRegistries(common, context.cwd);
    const resolved = throughManifest(target, known, flags);
    if (!resolved.declared) {
      const unknown = await undeclaredRegistry(target, known, common, context.cwd);
      if (unknown !== undefined) throw unknown;
    }
    const source = await probe({
      input: resolved.input,
      flags: resolved.flags,
      cwd: context.cwd,
      declared: resolved,
    });
    try {
      const catalog = source.catalog;
      return {
        registry: resolved.alias ?? source.alias,
        address: withoutCredentials(source.location),
        ...(source.revision === undefined ? {} : { revision: source.revision }),
        ...(source.layout !== undefined && isReadOnlyLayout(source.layout)
          ? { layout: source.layout }
          : {}),
        layouts: catalog.layouts,
        entries: catalog.entries.map((entry) => published(entry, source.versionOf(entry))),
        warnings: catalog.warnings,
      };
    } finally {
      await source.close();
    }
  },
  text(result, printer) {
    const style = printer.style;
    const revision =
      result.revision === undefined ? "" : style.dim(` @ ${abbreviate(result.revision)}`);
    printer.info(`${style.bold(result.registry)}${revision}`);
    fields(printer, [
      ["address", underHome(result.address)],
      ["layout", result.layout ?? (result.layouts.join(" + ") || "none")],
      ["artifacts", String(result.entries.length)],
    ]);

    if (result.entries.length === 0) {
      for (const warning of result.warnings) printer.warning(warning);
      return;
    }

    printer.info();
    table(
      printer,
      [
        {
          header: "artifact",
          value: (entry: PublishedArtifact) =>
            entry.namespace === undefined ? entry.name : `${entry.namespace}/${entry.name}`,
        },
        { header: "kind", value: (entry: PublishedArtifact) => style.dim(entry.kind) },
        {
          header: "needs",
          value: (entry: PublishedArtifact) =>
            entry.engine === undefined ? "" : style.dim(`aireg ${entry.engine}`),
          optional: true,
        },
        { header: "description", value: (entry: PublishedArtifact) => entry.description ?? "" },
      ],
      result.entries,
    );
    for (const warning of result.warnings) printer.warning(warning);
  },
});

function published(entry: Entry, version: string | undefined): PublishedArtifact {
  return {
    name: entry.name,
    kind: entry.kind,
    ...(entry.group === undefined ? {} : { namespace: entry.group }),
    path: entry.path,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.engine === undefined ? {} : { engine: entry.engine }),
    ...(version === undefined ? {} : { version }),
  };
}

/** With no argument, the one registry this project declares. */
async function onlyDeclared(context: CommandContext, common: CommonOptions): Promise<string> {
  const loaded = await load(common, context.cwd, "user");
  const aliases = Object.keys(loaded.manifest.registries);
  if (aliases.length === 1) return aliases[0] as string;
  // In a clone of a registry, it is the one meant.
  const here = aliases.length === 0 ? findRegistry(context.cwd) : undefined;
  if (here !== undefined) return here;
  throw needsInput(
    "registry show",
    "a registry name",
    aliases.length === 0
      ? "Name the registry: `aireg registry show <registry>`, such as github.com/owner/repo, a URL or a folder."
      : `Name one of ${listOf(aliases, "or")}: \`aireg registry show <registry>\`.`,
  );
}
