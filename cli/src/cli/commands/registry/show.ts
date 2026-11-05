import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import { list as listOf, withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
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
import type { Flags } from "./options.ts";

/** Reads what a registry publishes; nothing is installed. */
export async function show(
  context: CommandContext,
  input: string | undefined,
  flags: Flags,
  common: CommonOptions,
): Promise<void> {
  const target = input ?? (await onlyDeclared(context, common));
  const known = await knownRegistries(common, context.cwd);
  const resolved = throughManifest(target, known, flags);
  if (!resolved.declared) {
    const unknown = await undeclaredRegistry(target, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }
  const source = await probe(resolved.input, resolved.flags, context.cwd, [], resolved);
  const catalog = source.catalog;

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        registry: resolved.alias ?? source.alias,
        address: withoutCredentials(source.location),
        revision: source.revision,
        ...(isReadOnlyLayout(source.layout) ? { layout: source.layout } : {}),
        layouts: catalog.layouts,
        entries: catalog.entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          namespace: entry.group,
          path: entry.path,
          description: entry.description,
          engine: entry.engine,
          version: source.versionOf(entry),
        })),
        warnings: catalog.warnings,
      },
    });
    return;
  }

  const style = context.printer.style;
  const revision =
    source.revision === undefined ? "" : style.dim(` @ ${abbreviate(source.revision)}`);
  context.printer.info(`${style.bold(resolved.alias ?? source.alias)}${revision}`);
  fields(context.printer, [
    ["address", underHome(withoutCredentials(source.location))],
    [
      "layout",
      isReadOnlyLayout(source.layout)
        ? (source.layout as string)
        : catalog.layouts.join(" + ") || "none",
    ],
    ["artifacts", String(catalog.entries.length)],
  ]);

  if (catalog.entries.length === 0) {
    for (const warning of catalog.warnings) context.printer.warning(warning);
    return;
  }

  context.printer.info();
  table(
    context.printer,
    [
      {
        header: "artifact",
        value: (entry: Entry) =>
          entry.group === undefined ? entry.name : `${entry.group}/${entry.name}`,
      },
      { header: "kind", value: (entry: Entry) => style.dim(entry.kind) },
      {
        header: "needs",
        value: (entry: Entry) =>
          entry.engine === undefined ? "" : style.dim(`aireg ${entry.engine}`),
        optional: true,
      },
      { header: "description", value: (entry: Entry) => entry.description ?? "" },
    ],
    catalog.entries,
  );
  for (const warning of catalog.warnings) context.printer.warning(warning);
}

/** `aireg registry show` with no argument means the one this project declares. */
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
