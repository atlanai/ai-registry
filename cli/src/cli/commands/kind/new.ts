import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { list } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { STREAMED } from "#cli/commands/define.ts";
import type { KindNew } from "#cli/commands/kind/result.ts";
import type { Own } from "#cli/commands/kind.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, interaction, interactive } from "#cli/prompt/interaction.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { findRegistry } from "#core/filespec/init.ts";
import { type KindManifest, primaryFiles } from "#core/filespec/kind-manifests.ts";
import { refuseRedirect, writeFresh } from "#core/fs/fresh.ts";
import type { Printer } from "#core/term/printer.ts";
import { askFields, nameOf, render, scaffold, settings } from "./fields.ts";
import { outsidePlace, registryPlace } from "./place.ts";

export interface Created extends KindNew {
  edit: string | undefined;
  next: string;
}

export async function init(
  kind: string,
  manifest: KindManifest,
  context: CommandContext,
  input: string | undefined,
  own: Own,
  yes: boolean,
): Promise<Created | typeof STREAMED> {
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
    ? await registryPlace({ kind, root, context, own, yes, given, step })
    : outsidePlace(kind, files, context, given);
  if (place === undefined) return STREAMED;
  const { name, at } = place;
  const shown = relative(context.cwd, at) || ".";

  const { fields, todo } = scaffold(manifest, name, sets);
  if (interactive(step) && !(await askFields(step, fields, todo))) {
    cancel(step);
    return STREAMED;
  }

  const created = files.map((file) => (shown === "." ? file : `${shown}/${file}`));
  for (const file of files) refuseRedirect(inRegistry ? root : context.cwd, join(at, file));
  await mkdir(at, { recursive: true });
  for (const [index, file] of files.entries()) {
    await writeFresh(join(at, file), render(file, fields), {
      shown: created[index] as string,
      hint: "Move it aside, or name a new artifact.",
    });
  }

  // Publish takes a skill's folder, and any other kind's Markdown file.
  const publishable = files.includes(SKILL_ENTRY)
    ? shown
    : (created.find((file) => file.endsWith(".md")) ?? shown);
  return {
    kind,
    name,
    created,
    todo,
    edit: inRegistry ? shown : undefined,
    next: inRegistry
      ? "aireg registry index"
      : `aireg publish ${publishable} --to <registry>/<namespace>`,
  };
}

export function printCreated(result: Created, printer: Printer): void {
  printer.success(`Created ${list(result.created)}.`);
  if (result.todo.length > 0) printer.note("todo", list(result.todo));
  if (result.edit !== undefined) printer.note("edit", result.edit);
  printer.note("next", result.next);
}
