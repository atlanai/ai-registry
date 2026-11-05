import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { list } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import type { Own } from "#cli/commands/kind.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, interaction, interactive } from "#cli/prompt/interaction.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { findRegistry } from "#core/filespec/init.ts";
import { type KindManifest, primaryFiles } from "#core/filespec/kind-manifests.ts";
import { refuseRedirect, writeFresh } from "#core/fs/fresh.ts";
import { askFields, nameOf, render, scaffold, settings } from "./fields.ts";
import { outsidePlace, registryPlace } from "./place.ts";

export async function init(
  kind: string,
  manifest: KindManifest,
  context: CommandContext,
  input: string | undefined,
  own: Own,
  yes: boolean,
): Promise<void> {
  const root = findRegistry(context.cwd);
  const inRegistry = root !== undefined;
  const given = input === undefined ? undefined : nameOf(input, input);
  const files = primaryFiles(manifest, own.file);
  if (files.length === 0)
    throw new AiregError(`The ${kind} kind names no files to create.`, {
      code: ErrorCode.Invalid,
      hint: `List the ${kind} kind's files in the registry's \`kinds/\`, then run it again.`,
    });
  const sets = settings(own.set);
  const step = interaction(context.printer, defaultIo(), yes);

  const place = inRegistry
    ? await registryPlace(kind, root, context, own, yes, given, step)
    : outsidePlace(kind, files, context, given);
  if (place === undefined) return;
  const { name, at } = place;
  const shown = relative(context.cwd, at) || ".";

  const { fields, todo } = scaffold(manifest, name, sets);
  if (interactive(step) && !(await askFields(step, fields, todo))) return cancel(step);

  const created = files.map((file) => (shown === "." ? file : `${shown}/${file}`));
  for (const file of files) refuseRedirect(inRegistry ? root : context.cwd, join(at, file));
  await mkdir(at, { recursive: true });
  for (const [index, file] of files.entries()) {
    await writeFresh(join(at, file), render(file, fields), {
      shown: created[index] as string,
      hint: "Move it aside, or name a new artifact.",
    });
  }

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { kind, name, created, todo } });
    return;
  }
  context.printer.success(`Created ${list(created)}.`);
  if (todo.length > 0) context.printer.note("todo", list(todo));
  if (inRegistry) context.printer.note("edit", shown);
  // Publish takes a skill's folder, and any other kind's Markdown file.
  const publishable = files.includes(SKILL_ENTRY)
    ? shown
    : (created.find((file) => file.endsWith(".md")) ?? shown);
  context.printer.note(
    "next",
    inRegistry
      ? "aireg registry index"
      : `aireg publish ${publishable} --to <registry>/<namespace>`,
  );
}
