import type { McpEntry, Value } from "#core/mcp/model.ts";
import type { ConfigValue, ToolFilter } from "#core/target/contract.ts";
import { toolFields } from "./mcp-json.ts";

type Entry = Record<string, ConfigValue>;

const TOOLS = { allow: ["enabled_tools"], deny: ["disabled_tools"] };

/**
 * Codex expands no variable in its config: a secret reaches a server only as a whole variable it
 * forwards, by `env_vars`, `bearer_token_env_var` or `env_http_headers`.
 */
export function mcpCodex(entry: McpEntry, tools?: ToolFilter): Entry | string {
  const made = entry.transport === "stdio" ? local(entry) : remote(entry);
  if (typeof made === "string") return made;
  const filtered = toolFields(tools, TOOLS);
  if (typeof filtered === "string") return filtered;
  for (const [[key], names] of filtered) made[key as string] = names;
  return made;
}

const embedded = (field: string) =>
  `it needs a secret inside ${field}, and Codex reads a secret only as a whole variable`;

function local(entry: Extract<McpEntry, { transport: "stdio" }>): Entry | string {
  if (entry.args.some((arg) => typeof arg !== "string")) return embedded("an argument");
  const env: Record<string, string> = {};
  const forwarded: string[] = [];
  for (const [key, value] of Object.entries(entry.env)) {
    if (typeof value === "string") env[key] = value;
    else if (wholeSecret(value) === key) forwarded.push(key);
    else return embedded(`the variable ${key}`);
  }
  return {
    command: entry.command,
    args: entry.args as string[],
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(forwarded.length === 0 ? {} : { env_vars: forwarded }),
  };
}

function remote(entry: Exclude<McpEntry, { transport: "stdio" }>): Entry | string {
  if (typeof entry.url !== "string") return embedded("its URL");
  const out: Entry = { url: entry.url };
  const fixed: Record<string, string> = {};
  const fromEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.headers)) {
    const whole = wholeSecret(value);
    const bearer = name.toLowerCase() === "authorization" ? bearerSecret(value) : undefined;
    if (typeof value === "string") fixed[name] = value;
    else if (bearer !== undefined) out.bearer_token_env_var = bearer;
    else if (whole !== undefined) fromEnv[name] = whole;
    else return embedded(`the header ${name}`);
  }
  if (Object.keys(fixed).length > 0) out.http_headers = fixed;
  if (Object.keys(fromEnv).length > 0) out.env_http_headers = fromEnv;
  return out;
}

function wholeSecret(value: Value): string | undefined {
  if (typeof value === "string" || value.length !== 1) return undefined;
  const [part] = value;
  return typeof part === "object" ? part.secret : undefined;
}

function bearerSecret(value: Value): string | undefined {
  if (typeof value === "string" || value.length !== 2) return undefined;
  const [prefix, part] = value;
  return prefix === "Bearer " && typeof part === "object" ? part.secret : undefined;
}
