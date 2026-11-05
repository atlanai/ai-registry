import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { ifPresent } from "#adapter/files.ts";
import { ARTIFACTS_DIR, isNamespace } from "#adapter/filespec/names.ts";
import { isWithin } from "#adapter/paths.ts";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import type { Own } from "#cli/commands/kind.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, type Interaction, interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { select } from "#cli/prompt/select.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { askName, nameOf, valid } from "./fields.ts";

/** The namespace named, the one you are in, or one picked; undefined when the pick is canceled. */
export async function namespaceFor(
  root: string,
  cwd: string,
  own: Own,
  context: CommandContext,
  yes: boolean,
): Promise<string | undefined> {
  if (own.namespace !== undefined) return valid(own.namespace);
  const inside = namespaceHere(root, cwd);
  if (inside !== undefined) return inside;
  const existing = (
    (await ifPresent(readdir(join(root, ARTIFACTS_DIR), { withFileTypes: true }))) ?? []
  )
    .filter((item) => item.isDirectory() && isNamespace(item.name))
    .map((item) => item.name)
    .sort();
  const step = interaction(context.printer, defaultIo(), yes);
  if (!interactive(step) || existing.length === 0) {
    throw new AiregError("No namespace was given.", {
      code: ErrorCode.Usage,
      hint:
        existing.length === 0
          ? "Pass `--namespace <namespace>`, or run it inside artifacts/<namespace>."
          : `Pass \`--namespace\` with ${list(existing, "or")}, or run it inside artifacts/<namespace>.`,
    });
  }
  const picked = await select<string>(
    {
      message: "Which namespace?",
      style: context.printer.errStyle,
      initial: existing[0] as string,
      options: existing.map((item) => ({ value: item, label: item })),
    },
    step.io,
  );
  if (canceled(picked)) {
    cancel(step);
    return undefined;
  }
  return picked;
}

function namespaceHere(root: string, cwd: string): string | undefined {
  const artifacts = join(root, ARTIFACTS_DIR);
  if (!isWithin(artifacts, cwd)) return undefined;
  const inside = relative(artifacts, cwd).split(sep)[0];
  return inside !== undefined && isNamespace(inside) ? inside : undefined;
}

interface RegistryPlace {
  kind: string;
  root: string;
  context: CommandContext;
  own: Own;
  yes: boolean;
  given: string | undefined;
  step: Interaction;
}

/** `artifacts/<namespace>/<kind>/<name>/0.1.0`, with the namespace and name asked for when missing. */
export async function registryPlace({
  kind,
  root,
  context,
  own,
  yes,
  given,
  step,
}: RegistryPlace): Promise<{ name: string; at: string } | undefined> {
  const namespace = await namespaceFor(root, context.cwd, own, context, yes);
  if (namespace === undefined) return undefined;
  const name = given ?? (await askName(kind, step));
  if (name === undefined) {
    cancel(step);
    return undefined;
  }
  const home = join(root, ARTIFACTS_DIR, namespace, kind, name);
  if (existsSync(home)) {
    throw new AiregError(`${namespace}/${kind}/${name} already exists.`, {
      code: ErrorCode.Conflict,
      hint: `Start its next version with \`aireg ${kind} bump ${name}\`.`,
    });
  }
  return { name, at: join(home, "0.1.0") };
}

/** `./<name>`, or this folder named after itself when no name is given. */
export function outsidePlace(
  kind: string,
  files: readonly string[],
  context: CommandContext,
  given: string | undefined,
): { name: string; at: string } {
  const name = given ?? nameOf(undefined, sanitizeName(basename(context.cwd)));
  const at = given === undefined ? context.cwd : join(context.cwd, name);
  const shown = relative(context.cwd, at) || ".";
  for (const file of files) {
    if (existsSync(join(at, file)))
      throw new AiregError(`${join(shown, file)} already exists.`, {
        code: ErrorCode.Conflict,
        hint: `Run it in an empty folder, or name a new one: \`aireg ${kind} new <name>\`.`,
      });
  }
  return { name, at };
}

/** The one `<namespace>/<kind>/<name>` folder a bare name means here. */
export async function locate(
  root: string,
  cwd: string,
  kind: string,
  name: string,
  namespace: string | undefined,
): Promise<string> {
  const wanted = namespace ?? namespaceHere(root, cwd);
  const candidates = (
    (await ifPresent(readdir(join(root, ARTIFACTS_DIR), { withFileTypes: true }))) ?? []
  )
    .filter((item) => item.isDirectory() && (wanted === undefined || item.name === wanted))
    .map((item) => join(root, ARTIFACTS_DIR, item.name, kind, name))
    .filter((path) => existsSync(path));
  if (candidates.length === 1) return candidates[0] as string;
  if (candidates.length === 0) {
    // `new` infers only the namespace you are in, so any other has to be named.
    let flag = "";
    if (namespace !== undefined) flag = ` --namespace ${namespace}`;
    else if (wanted === undefined) flag = " --namespace <namespace>";
    throw new AiregError(
      `No ${kind} named ${quoted(name)}${wanted === undefined ? "" : ` in ${wanted}`}.`,
      {
        code: ErrorCode.NotFound,
        hint: `Create it with \`aireg ${kind} new ${name}${flag}\`.`,
      },
    );
  }
  throw new AiregError(`${name} is in more than one namespace.`, {
    code: ErrorCode.Usage,
    hint: "Pass `--namespace <namespace>`, or run it inside artifacts/<namespace>.",
  });
}
