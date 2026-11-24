import { isRecord } from "#adapter/fields.ts";
import { MCP_POLICY_META } from "#adapter/kinds.ts";
import { list, quoted } from "#adapter/text.ts";
import type { KindManifest, SchemaNode } from "./kind-manifests.ts";

/** What a policy may say about one input `server.json` declares under a name. */
interface Declared {
  secret: boolean;
  fixed: boolean;
  choices?: readonly string[];
}

/**
 * The checks `kinds/mcp_server.json` cannot state, since they span `policy.json` and
 * `server.json`: each fixed input names a declared input that is neither secret nor fixed by the
 * publisher, and is one of its choices when it has them (file spec section 3.4).
 */
export function mcpPolicyProblems(spec: Record<string, unknown>): string[] {
  const { server, _meta: meta } = spec;
  const policy = isRecord(meta) ? meta[MCP_POLICY_META] : undefined;
  if (!isRecord(policy) || !isRecord(policy.inputs)) return [];
  const declared = declaredInputs(server);
  const problems: string[] = [];
  for (const [name, value] of Object.entries(policy.inputs)) {
    const field = `\`policy.inputs.${name}\``;
    const inputs = declared.get(name);
    if (inputs === undefined) {
      problems.push(`${field} names no input server.json declares`);
    } else if (inputs.some((input) => input.secret)) {
      problems.push(`${field} is a secret in server.json, so the policy cannot give it a value`);
    } else if (inputs.some((input) => input.fixed)) {
      problems.push(`${field} already has a value in server.json`);
    } else {
      for (const { choices } of inputs) {
        if (choices !== undefined && typeof value === "string" && !choices.includes(value)) {
          problems.push(
            `${field} ${quoted(value)} is not one of its choices, ${list(choices.map(quoted), "or")}`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Every input `server.json` declares, by the name its URL templates resolve: environment
 * variables, headers and named arguments by `name`, positional arguments by `valueHint`, and
 * template variables by their key. One name can be declared in several packages and remotes.
 */
function declaredInputs(server: unknown): Map<string, Declared[]> {
  const found = new Map<string, Declared[]>();
  const add = (name: unknown, input: Record<string, unknown>): void => {
    if (typeof name !== "string") return;
    const choices = Array.isArray(input.choices)
      ? input.choices.filter((choice): choice is string => typeof choice === "string")
      : undefined;
    const entry: Declared = { secret: input.isSecret === true, fixed: input.value !== undefined };
    if (choices !== undefined) entry.choices = choices;
    found.set(name, [...(found.get(name) ?? []), entry]);
  };
  const variables = (input: Record<string, unknown>): void => {
    if (!isRecord(input.variables)) return;
    for (const [key, variable] of Object.entries(input.variables)) {
      if (isRecord(variable)) add(key, variable);
    }
  };
  const each = (inputs: unknown, nameOf: (input: Record<string, unknown>) => unknown): void => {
    for (const input of Array.isArray(inputs) ? inputs : []) {
      if (!isRecord(input)) continue;
      add(nameOf(input), input);
      variables(input);
    }
  };
  const argumentName = (input: Record<string, unknown>): unknown =>
    input.type === "positional" ? input.valueHint : input.name;
  if (!isRecord(server)) return found;
  for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
    if (!isRecord(pkg)) continue;
    each(pkg.environmentVariables, (input) => input.name);
    each(pkg.runtimeArguments, argumentName);
    each(pkg.packageArguments, argumentName);
    if (isRecord(pkg.transport)) each(pkg.transport.headers, (input) => input.name);
  }
  for (const remote of Array.isArray(server.remotes) ? server.remotes : []) {
    if (!isRecord(remote)) continue;
    variables(remote);
    each(remote.headers, (input) => input.name);
  }
  return found;
}

/**
 * What `new` fills in for an MCP server: the fields `server.json` requires, under the newest
 * schema version the kind takes, rather than the envelope's `spec`, which wraps the file.
 */
export function serverSkeleton(manifest: KindManifest): SchemaNode {
  const versions = manifest.properties?.server?.properties?.$schema?.enum;
  const newest = Array.isArray(versions)
    ? versions
        .filter((url): url is string => typeof url === "string")
        .sort()
        .at(-1)
    : undefined;
  return {
    type: "object",
    required: ["$schema", "name", "description", "version"],
    properties: {
      $schema: newest === undefined ? { type: "string" } : { type: "string", default: newest },
      name: { type: "string" },
      description: { type: "string" },
      version: { type: "string", default: "0.1.0" },
    },
  };
}
