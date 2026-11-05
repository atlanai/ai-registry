import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readRegistry } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { ARTIFACTS_DIR, isNamespace, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { list as listOf, plural, quoted, sanitizeName } from "#adapter/text.ts";
import { parseSource } from "#adapters/git/api.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, type Interaction, interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { text } from "#cli/prompt/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeRoot } from "#core/filespec/init.ts";
import { refuseRedirect } from "#core/fs/fresh.ts";
import { gitIn } from "#core/process.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Flags } from "./options.ts";

/** A registry is created where you are, as files; publishing it is your version control's job. */
export async function init(
  context: CommandContext,
  input: string | undefined,
  flags: Flags,
  common: CommonOptions,
): Promise<void> {
  if (input !== undefined && REMOTE.test(input)) {
    throw new AiregError(
      "`aireg registry init` creates a registry in a folder, not at an address.",
      {
        code: ErrorCode.Usage,
        hint: "Clone the repository, cd into it, and run `aireg registry init`.",
      },
    );
  }
  const root = resolve(context.cwd, input ?? ".");
  const shown = relative(context.cwd, root) || ".";
  if (existsSync(join(root, REGISTRY_DOCUMENT))) {
    return extend(context, root, shown, namespacesOf(flags.namespace ?? []));
  }

  const step = interaction(context.printer, defaultIo(), common.yes);
  const suggested = (await remoteOwner(root)) ?? basename(root);
  const name =
    flags.name ??
    (await ask(step, "Name", suggested, `Type a name, or press Enter to use ${suggested}.`));
  if (name === undefined) return cancel(step);
  const description =
    flags.description ??
    (await ask(
      step,
      "Description",
      "",
      "Optional. Type one line, such as Skills our team shares.",
    ));
  if (description === undefined) return cancel(step);
  const listed =
    flags.namespace ??
    splitList(
      await ask(
        step,
        "Namespaces",
        "",
        "Optional. Type names separated by commas or spaces: engineering, data.",
      ),
    );
  if (listed === undefined) return cancel(step);
  const namespaces = namespacesOf(listed);

  for (const folder of ["", ...namespaces]) refuseRedirect(root, join(root, ARTIFACTS_DIR, folder));
  await mkdir(join(root, ARTIFACTS_DIR), { recursive: true });
  const written = await writeRoot(
    root,
    { name, ...(description === "" ? {} : { description }) },
    new Date().toISOString(),
  );
  for (const namespace of namespaces) {
    await mkdir(join(root, ARTIFACTS_DIR, namespace), { recursive: true });
  }
  const slug = sanitizeName(name);

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { root, created: true, slug, namespaces } });
    return;
  }
  context.printer.success(`Created registry ${slug} in ${shown === "." ? "this folder" : shown}.`);
  for (const path of [...written, ...namespaces.map((item) => `artifacts/${item}/`)]) {
    context.printer.info(`    ${path}`);
  }
  const into = [shown === "." ? undefined : shown, namespaces[0] && `artifacts/${namespaces[0]}`]
    .filter(Boolean)
    .join("/");
  // Inside a namespace's folder, `skill new` knows the namespace; anywhere else it is named.
  const named = namespaces[0] === undefined ? " --namespace <namespace>" : "";
  context.printer.note(
    "next",
    `${into === "" ? "" : `cd ${into} && `}aireg skill new <name>${named}`,
  );
}

/** `init` in a registry adds only the namespaces it was given; the registry itself is left as it is. */
async function extend(
  context: CommandContext,
  root: string,
  shown: string,
  namespaces: readonly string[],
): Promise<void> {
  const added = namespaces.filter((item) => !existsSync(join(root, ARTIFACTS_DIR, item)));
  for (const item of added) refuseRedirect(root, join(root, ARTIFACTS_DIR, item));
  for (const namespace of added) {
    await mkdir(join(root, ARTIFACTS_DIR, namespace), { recursive: true });
  }
  if (context.printer.format === "json") {
    const registry = await readRegistry(rootReader(root));
    const slug = registry.slug ?? registry.name;
    context.printer.json({ ok: true, data: { root, created: false, slug, namespaces: added } });
    return;
  }
  const where = shown === "." ? "This folder" : shown;
  if (added.length === 0) {
    context.printer.info(`${where} is already a registry. Nothing was changed.`);
    return;
  }
  context.printer.success(
    `Added ${plural(added.length, "namespace")} to the registry in ${shown === "." ? "this folder" : shown}: ${listOf(added)}.`,
  );
  for (const namespace of added) context.printer.info(`    artifacts/${namespace}/`);
}

/** Each namespace once, or a usage error naming the ones that cannot be one. */
function namespacesOf(listed: readonly string[]): string[] {
  const namespaces = [...new Set(listed.map((item) => item.trim()).filter(Boolean))];
  const invalid = namespaces.filter((item) => !isNamespace(item));
  if (invalid.length > 0) {
    throw new AiregError(
      `${listOf(invalid.map(quoted))} ${invalid.length === 1 ? "is not a namespace" : "are not namespaces"}.`,
      {
        code: ErrorCode.Usage,
        hint: "Use lowercase letters, digits and hyphens, such as platform.",
      },
    );
  }
  return namespaces;
}

/** Anything that reads as an address somewhere else, not a folder here. */
const REMOTE = /^[a-z+]+:\/\/|^[\w.-]+@[\w.-]+:|^[\w-]+(\.[\w-]+)+\//i;

/** The owner of the repository this folder pushes to, which is who the registry is usually named for. */
async function remoteOwner(root: string): Promise<string | undefined> {
  const attempt = await gitIn(existsSync(root) ? root : dirname(root), [
    "remote",
    "get-url",
    "origin",
  ]);
  if (attempt.code !== 0) return undefined;
  try {
    return parseSource(attempt.stdout.trim()).slug?.split("/")[0];
  } catch {
    return undefined;
  }
}

/** Asked on a terminal; anywhere else, and under --yes, the suggestion is the answer. */
async function ask(
  step: Interaction,
  message: string,
  initial: string,
  hint: string,
): Promise<string | undefined> {
  if (!interactive(step)) return initial;
  const answer = await text({ message, style: step.printer.errStyle, initial, hint }, step.io);
  return canceled(answer) ? undefined : answer;
}

function splitList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(/[\s,]+/).filter(Boolean);
}
