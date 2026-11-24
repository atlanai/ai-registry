import type { McpEntry, Value } from "#core/mcp/model.ts";
import type { ConfigCodec, ConfigValue } from "#core/target/contract.ts";

type Secret = ConfigCodec["secret"];

/** `command`, `args` and `env` for a local server; `type`, `url` and `headers` for a remote. */
export function mcpJson(entry: McpEntry, secret: Secret): Record<string, ConfigValue> {
  const text = (value: Value) => render(value, secret);
  const map = (values: Record<string, Value>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, text(value)]));
  if (entry.transport === "stdio") {
    return {
      command: entry.command,
      args: entry.args.map(text),
      ...(Object.keys(entry.env).length === 0 ? {} : { env: map(entry.env) }),
    };
  }
  return {
    type: entry.transport === "sse" ? "sse" : "http",
    url: text(entry.url),
    ...(Object.keys(entry.headers).length === 0 ? {} : { headers: map(entry.headers) }),
  };
}

function render(value: Value, { prefix, suffix }: Secret): string {
  if (typeof value === "string") return value;
  return value
    .map((part) => (typeof part === "string" ? part : `${prefix}${part.secret}${suffix}`))
    .join("");
}
