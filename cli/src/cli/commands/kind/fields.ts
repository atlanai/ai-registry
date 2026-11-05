import { stringify } from "yaml";
import { isArtifactName, isNamespace } from "#adapter/filespec/names.ts";
import { quoted } from "#adapter/text.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { text } from "#cli/prompt/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { RESERVED_KEYS } from "#core/fields.ts";
import type { SchemaNode } from "#core/filespec/kind-manifests.ts";
import { PLACEHOLDER, refuseDevice } from "./files.ts";

export function valid(namespace: string): string {
  refuseDevice(namespace);
  if (!isNamespace(namespace)) {
    throw new AiregError(`${quoted(namespace)} is not a namespace.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and hyphens, such as platform.",
    });
  }
  return namespace;
}

export function nameOf(input: string | undefined, fallback: string): string {
  const name = input ?? fallback;
  refuseDevice(name);
  if (!isArtifactName(name)) {
    throw new AiregError(`${quoted(name)} is not a valid artifact name.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and hyphens, such as deploy.",
    });
  }
  return name;
}

/** `a.b=c` pairs, applied over what the manifest asks for. */
export function settings(pairs: readonly string[] | undefined): [string[], string][] {
  return (pairs ?? []).map((pair) => {
    const at = pair.indexOf("=");
    const path = pair.slice(0, Math.max(at, 0)).split(".");
    if (at < 1 || path.some((key) => key === "" || RESERVED_KEYS.has(key))) {
      throw new AiregError(`--set takes <key>=<value>, not ${quoted(pair)}.`, {
        code: ErrorCode.Usage,
        hint: "Name a field, with dots for nested ones: `--set metadata.category=engineering`.",
      });
    }
    return [path, pair.slice(at + 1)];
  });
}

export function scaffold(
  schema: SchemaNode,
  name: string,
  sets: readonly [string[], string][],
): { fields: Record<string, unknown>; todo: string[] } {
  const todo: string[] = [];
  function fill(node: SchemaNode, path: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of node.required ?? []) {
      const child = node.properties?.[key] ?? {};
      const at = [...path, key];
      if (at.join(".") === "name") out[key] = name;
      else if (child.default !== undefined) out[key] = child.default;
      else if ([child.type].flat().includes("object") && child.required !== undefined)
        out[key] = fill(child, at);
      else {
        out[key] = PLACEHOLDER;
        todo.push(at.join("."));
      }
    }
    return out;
  }
  const fields = fill(schema, []);
  for (const [path, value] of sets) assign(fields, todo, path, value);
  return { fields, todo };
}

function assign(fields: Record<string, unknown>, todo: string[], path: string[], value: string) {
  let node = fields;
  for (const key of path.slice(0, -1)) {
    node[key] = typeof node[key] === "object" && node[key] !== null ? node[key] : {};
    node = node[key] as Record<string, unknown>;
  }
  node[path.at(-1) as string] = value;
  const index = todo.indexOf(path.join("."));
  if (index !== -1) todo.splice(index, 1);
}

/** An empty answer leaves the field to fill in later. */
export async function askFields(
  step: Interaction,
  fields: Record<string, unknown>,
  todo: string[],
) {
  for (const path of [...todo]) {
    const label = path.replaceAll(".", " ");
    const message = label.charAt(0).toUpperCase() + label.slice(1);
    const answer = await text(
      {
        message,
        style: step.printer.errStyle,
        hint: "Type a value, or press Enter to leave it as TODO for now.",
      },
      step.io,
    );
    if (canceled(answer)) return false;
    if (answer !== "") assign(fields, todo, path.split("."), answer);
  }
  return true;
}

/** A registry folder's name is never the artifact's, so the name is asked for. */
export async function askName(kind: string, step: Interaction): Promise<string | undefined> {
  if (!interactive(step))
    throw new AiregError(`\`aireg ${kind} new\` needs a name in a registry.`, {
      code: ErrorCode.Usage,
      hint: `Run \`aireg ${kind} new <name>\`.`,
    });
  const answer = await text(
    {
      message: "Name",
      style: step.printer.errStyle,
      hint: "Type a name: lowercase letters, digits and hyphens, such as pr-review.",
    },
    step.io,
  );
  return canceled(answer) ? undefined : nameOf(answer, answer);
}

export function render(path: string, fields: Record<string, unknown>): string {
  if (path.endsWith(".json")) return `${JSON.stringify(fields, undefined, 2)}\n`;
  return `---\n${stringify(fields, { lineWidth: 0 })}---\n`;
}
