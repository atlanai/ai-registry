import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readRegistry } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { ARTIFACTS_DIR, isNamespace, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { list as listOf, plural, quoted, sanitizeName } from "#adapter/text.ts";
import { parseSource } from "#adapters/git/api.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { action, STREAMED } from "#cli/commands/define.ts";
import type { RegistryCreated } from "#cli/commands/registry/result.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, type Interaction, interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled as isCanceled } from "#cli/prompt/model.ts";
import { text } from "#cli/prompt/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeRoot } from "#core/filespec/init.ts";
import { refuseRedirect } from "#core/fs/fresh.ts";
import { gitIn } from "#core/process.ts";
import type { Options } from "./options.ts";

interface Initialized {
  data: RegistryCreated;
  /** The folder as typed from where you are, `.` for this one. */
  shown: string;
  written: string[];
}

export const init = action({
  async run(
    { argument: input, flags, common }: Options,
    context,
  ): Promise<Initialized | typeof STREAMED> {
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
    if (name === undefined) return canceled(step);
    const description =
      flags.description ??
      (await ask(
        step,
        "Description",
        "",
        "Optional. Type one line, such as Skills our team shares.",
      ));
    if (description === undefined) return canceled(step);
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
    if (listed === undefined) return canceled(step);
    const namespaces = namespacesOf(listed);

    for (const folder of ["", ...namespaces]) {
      refuseRedirect(root, join(root, ARTIFACTS_DIR, folder));
    }
    await mkdir(join(root, ARTIFACTS_DIR), { recursive: true });
    const written = await writeRoot(
      root,
      { name, ...(description === "" ? {} : { description }) },
      new Date().toISOString(),
    );
    for (const namespace of namespaces) {
      await mkdir(join(root, ARTIFACTS_DIR, namespace), { recursive: true });
    }
    return {
      data: { root, created: true, slug: sanitizeName(name), namespaces },
      shown,
      written,
    };
  },
  data: (result) => result.data,
  text({ data, shown, written }, printer) {
    const where = shown === "." ? "this folder" : shown;
    if (!data.created) {
      if (data.namespaces.length === 0) {
        printer.info(
          `${shown === "." ? "This folder" : shown} is already a registry. Nothing was changed.`,
        );
        return;
      }
      printer.success(
        `Added ${plural(data.namespaces.length, "namespace")} to the registry in ${where}: ${listOf(data.namespaces)}.`,
      );
      for (const namespace of data.namespaces) printer.info(`    artifacts/${namespace}/`);
      return;
    }
    const { namespaces } = data;
    printer.success(`Created registry ${data.slug} in ${where}.`);
    for (const path of [...written, ...namespaces.map((item) => `artifacts/${item}/`)]) {
      printer.info(`    ${path}`);
    }
    const into = [shown === "." ? undefined : shown, namespaces[0] && `artifacts/${namespaces[0]}`]
      .filter(Boolean)
      .join("/");
    // Inside a namespace's folder, `skill new` knows the namespace; anywhere else it is named.
    const named = namespaces[0] === undefined ? " --namespace <namespace>" : "";
    printer.note("next", `${into === "" ? "" : `cd ${into} && `}aireg skill new <name>${named}`);
  },
});

/** In a registry already, only the namespaces given are added; the rest is left as it is. */
async function extend(
  context: CommandContext,
  root: string,
  shown: string,
  namespaces: readonly string[],
): Promise<Initialized> {
  const added = namespaces.filter((item) => !existsSync(join(root, ARTIFACTS_DIR, item)));
  for (const item of added) refuseRedirect(root, join(root, ARTIFACTS_DIR, item));
  for (const namespace of added) {
    await mkdir(join(root, ARTIFACTS_DIR, namespace), { recursive: true });
  }
  // Only --json shows the slug, so only it reads registry.json and fails on one it cannot read.
  const slug = context.printer.format === "json" ? await slugOf(root) : "";
  return { data: { root, created: false, slug, namespaces: added }, shown, written: [] };
}

async function slugOf(root: string): Promise<string> {
  const registry = await readRegistry(rootReader(root));
  return registry.slug ?? registry.name;
}

function canceled(step: Interaction): typeof STREAMED {
  cancel(step);
  return STREAMED;
}

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

/** The registry is usually named for the owner of the repository this folder pushes to. */
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

/** Off a terminal, and under --yes, the suggestion is the answer. */
async function ask(
  step: Interaction,
  message: string,
  initial: string,
  hint: string,
): Promise<string | undefined> {
  if (!interactive(step)) return initial;
  const answer = await text({ message, style: step.printer.errStyle, initial, hint }, step.io);
  return isCanceled(answer) ? undefined : answer;
}

function splitList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(/[\s,]+/).filter(Boolean);
}
