import type { McpEntry, Value } from "#core/mcp/model.ts";
import type { ConfigValue, McpJsonCodec, SecretField, ToolFilter } from "#core/target/contract.ts";

type Entry = Record<string, ConfigValue>;

/** The target's entry for a resolved server, or why the codec cannot write it. */
export function mcpJson(entry: McpEntry, codec: McpJsonCodec, tools?: ToolFilter): Entry | string {
  try {
    const made = entry.transport === "stdio" ? local(entry, codec) : remote(entry, codec);
    const type = codec.type?.[entry.transport];
    const out = type === undefined ? made : { type, ...made };
    const filtered = toolFields(tools, codec.tools);
    if (typeof filtered === "string") return filtered;
    for (const [path, names] of filtered) setPath(out, path, names);
    return out;
  } catch (error) {
    if (error instanceof Unwritable) return error.message;
    throw error;
  }
}

interface ToolKeys {
  allow?: string[] | undefined;
  deny?: string[] | undefined;
}

/**
 * Allowed tools less denied ones go in the allow list, so either precedence a target applies
 * gives the same set; a deny list alone goes in the deny list.
 */
export function toolFields(
  tools: ToolFilter | undefined,
  keys: ToolKeys | undefined,
): [string[], string[]][] | string {
  const allow = tools?.allow ?? [];
  const deny = tools?.deny ?? [];
  if (allow.length === 0 && deny.length === 0) return [];
  if (allow.length > 0) {
    if (keys?.allow === undefined) return "it allows only some tools, which this target cannot";
    return [[keys.allow, allow.filter((name) => !deny.includes(name))]];
  }
  if (keys?.deny === undefined) return "it denies some tools, which this target cannot";
  return [[keys.deny, [...deny]]];
}

class Unwritable extends Error {}

function local(entry: Extract<McpEntry, { transport: "stdio" }>, codec: McpJsonCodec): Entry {
  const args = entry.args.map((value) => text(value, codec, "args"));
  const env = map(entry.env, codec, "env");
  const command =
    codec.command === "array"
      ? { command: [entry.command, ...args] }
      : { command: entry.command, args };
  return {
    ...command,
    ...(Object.keys(env).length === 0 ? {} : { [codec.env ?? "env"]: env }),
  };
}

function remote(entry: Exclude<McpEntry, { transport: "stdio" }>, codec: McpJsonCodec): Entry {
  const headers = map(entry.headers, codec, "headers");
  return {
    [codec.url?.[entry.transport] ?? "url"]: text(entry.url, codec, "url"),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

function map(values: Record<string, Value>, codec: McpJsonCodec, field: SecretField) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, text(value, codec, field)]),
  );
}

function text(value: Value, codec: McpJsonCodec, field: SecretField): string {
  if (typeof value === "string") return value;
  const { secret } = codec;
  if (secret === undefined) {
    throw new Unwritable("it needs a secret, and this target has no way to read one");
  }
  if (secret.in !== undefined && !secret.in.includes(field)) {
    throw new Unwritable(`it needs a secret in ${field}, where this target reads none`);
  }
  return value
    .map((part) =>
      typeof part === "string" ? part : `${secret.prefix}${part.secret}${secret.suffix}`,
    )
    .join("");
}

function setPath(entry: Entry, path: readonly string[], value: ConfigValue): void {
  let node = entry;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[key] = {};
    node = node[key] as Entry;
  }
  node[path.at(-1) as string] = value;
}
