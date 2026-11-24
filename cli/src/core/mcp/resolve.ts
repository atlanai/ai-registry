import { isRecord } from "#adapter/fields.ts";
import { quoted } from "#adapter/text.ts";
import type {
  McpEntry,
  McpOption,
  McpSettings,
  RemoteTransport,
  Resolved,
  SecretRef,
  Transport,
  Value,
} from "./model.ts";

type Json = Record<string, unknown>;

/** A value missing that nothing supplies, or one outside its choices. */
class Missing extends Error {}

interface Context {
  settings: McpSettings;
  secrets: Set<string>;
}

/** Every way a server.json says it runs, with the project's settings applied; nothing is started. */
export function resolveServer(server: unknown, settings: McpSettings = {}): Resolved {
  const options: McpOption[] = [];
  const leftOut: string[] = [];
  const doc = isRecord(server) ? server : {};
  for (const remote of records(doc.remotes)) attempt(() => remoteEntry(remote, settings));
  for (const pkg of records(doc.packages)) attempt(() => packageEntry(pkg, settings));
  return { options, leftOut };

  function attempt(make: () => McpOption | string): void {
    try {
      const made = make();
      if (typeof made === "string") leftOut.push(made);
      else options.push(made);
    } catch (error) {
      if (!(error instanceof Missing)) throw error;
      leftOut.push(error.message);
    }
  }
}

/** A remote whose transport the target loads, else a package; why not, when neither fits. */
export function chooseOption(
  resolved: Resolved,
  supports: readonly Transport[],
): McpOption | string {
  const fits = (option: McpOption) => supports.includes(option.entry.transport);
  const found = resolved.options.find(fits);
  if (found !== undefined) return found;
  if (resolved.options.length > 0) {
    const offered = [...new Set(resolved.options.map((option) => option.entry.transport))];
    return `it runs over ${offered.join(" or ")}, which this target does not load`;
  }
  return resolved.leftOut.length > 0
    ? resolved.leftOut.join("; ")
    : "its server.json names no package or remote";
}

function remoteEntry(remote: Json, settings: McpSettings): McpOption | string {
  const type = remote.type;
  if (type !== "streamable-http" && type !== "sse") {
    return `a remote of type ${quoted(String(type))} is not one aireg writes`;
  }
  const context: Context = { settings, secrets: new Set() };
  const url = template(text(remote.url) ?? "", vars(remote.variables), context);
  if (url === undefined) throw new Missing("a remote has no URL");
  const headers: Record<string, Value> = {};
  for (const header of records(remote.headers)) {
    const name = text(header.name);
    const value = name === undefined ? undefined : input(header, name, context);
    if (name !== undefined && value !== undefined) headers[name] = value;
  }
  const entry: McpEntry = { transport: type as RemoteTransport, url, headers };
  return { entry, secrets: [...context.secrets].sort() };
}

const RUNTIMES: Record<
  string,
  { command: string; before: string[]; ref: (id: string, v?: string) => string; after: string[] }
> = {
  npm: { command: "npx", before: ["-y"], ref: (id, v) => (v ? `${id}@${v}` : id), after: [] },
  pypi: { command: "uvx", before: [], ref: (id, v) => (v ? `${id}==${v}` : id), after: [] },
  nuget: { command: "dnx", before: [], ref: (id, v) => (v ? `${id}@${v}` : id), after: ["--yes"] },
  oci: { command: "docker", before: ["run", "-i", "--rm"], ref: (id) => id, after: [] },
};

function packageEntry(pkg: Json, settings: McpSettings): McpOption | string {
  const type = text(pkg.registryType) ?? "";
  const id = text(pkg.identifier);
  const runtime = RUNTIMES[type];
  if (runtime === undefined || id === undefined) {
    return `a package of type ${quoted(type)} is not one aireg can start`;
  }
  const transport = isRecord(pkg.transport) ? pkg.transport.type : undefined;
  if (transport !== "stdio") {
    return `the ${type} package serves over ${String(transport)}, so it would need starting first`;
  }
  const context: Context = { settings, secrets: new Set() };
  const env: Record<string, Value> = {};
  for (const variable of records(pkg.environmentVariables)) {
    const name = text(variable.name);
    const value = name === undefined ? undefined : input(variable, name, context);
    if (name !== undefined && value !== undefined) env[name] = value;
  }
  const hint = text(pkg.runtimeHint);
  // Docker passes the host's variables on only when each is named.
  const forwarded = type === "oci" ? Object.keys(env).flatMap((name) => ["-e", name]) : [];
  const args: Value[] = [
    ...(hint === undefined ? [...runtime.before, ...forwarded] : []),
    ...argumentsOf(pkg.runtimeArguments, context),
    runtime.ref(id, text(pkg.version)),
    ...(hint === undefined ? runtime.after : []),
    ...argumentsOf(pkg.packageArguments, context),
  ];
  const entry: McpEntry = { transport: "stdio", command: hint ?? runtime.command, args, env };
  return { entry, secrets: [...context.secrets].sort() };
}

function argumentsOf(raw: unknown, context: Context): Value[] {
  const out: Value[] = [];
  for (const arg of records(raw)) {
    const named = arg.type === "named" ? text(arg.name) : undefined;
    const key = named?.replace(/^-+/, "") ?? text(arg.valueHint) ?? "";
    const values =
      arg.isRepeated === true ? repeated(arg, key, context) : [input(arg, key, context)];
    for (const value of values) {
      if (value === undefined) continue;
      out.push(named === undefined ? value : join(`${named}=`, value));
    }
  }
  return out;
}

function repeated(arg: Json, key: string, context: Context): (Value | undefined)[] {
  const given = context.settings.with?.[key];
  if (!Array.isArray(given) || arg.isSecret === true) return [input(arg, key, context)];
  return given.map((each) => input({ ...arg, default: undefined }, key, context, each));
}

/** A fixed value, then `with`, then the default; a secret only ever becomes a reference. */
function input(item: Json, key: string, context: Context, given?: string): Value | undefined {
  if (item.isSecret === true && text(item.value) === undefined) return secretRef(key, context);
  const fixed = text(item.value);
  if (fixed !== undefined) return template(fixed, vars(item.variables), context);
  const supplied = given ?? single(context.settings.with?.[key]);
  const value = supplied ?? text(item.default);
  if (value === undefined) {
    if (item.isRequired === true) {
      if (context.settings.placeholders === true) return `<${key}>`;
      throw new Missing(`it needs ${quoted(key)}, which nothing sets; give it under \`with\``);
    }
    return undefined;
  }
  const choices = Array.isArray(item.choices)
    ? item.choices.filter((c) => typeof c === "string")
    : [];
  if (choices.length > 0 && !choices.includes(value)) {
    throw new Missing(`${quoted(key)} is ${quoted(value)}, not one of ${choices.join(", ")}`);
  }
  return value;
}

/** `{name}` in a value takes that variable, which may itself be a secret. */
function template(
  raw: string,
  variables: Record<string, Json>,
  context: Context,
): Value | undefined {
  const parts: (string | SecretRef)[] = [];
  let last = 0;
  for (const match of raw.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)) {
    const variable = variables[match[1] as string];
    if (variable === undefined) continue;
    parts.push(raw.slice(last, match.index));
    const value = input(variable, match[1] as string, context);
    if (value === undefined) return undefined;
    parts.push(...(typeof value === "string" ? [value] : value));
    last = match.index + match[0].length;
  }
  parts.push(raw.slice(last));
  return flatten(parts);
}

function secretRef(key: string, context: Context): Value {
  const own = key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const secret = context.settings.env?.[own] ?? own;
  context.secrets.add(secret);
  return [{ secret }];
}

function join(prefix: string, value: Value): Value {
  return typeof value === "string" ? `${prefix}${value}` : flatten([prefix, ...value]);
}

function flatten(parts: readonly (string | SecretRef)[]): Value {
  const merged: (string | SecretRef)[] = [];
  for (const part of parts) {
    const prev = merged.at(-1);
    if (part === "") continue;
    if (typeof part === "string" && typeof prev === "string")
      merged[merged.length - 1] = prev + part;
    else merged.push(part);
  }
  if (merged.length === 0) return "";
  return merged.length === 1 && typeof merged[0] === "string" ? merged[0] : merged;
}

function single(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function vars(raw: unknown): Record<string, Json> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((pair): pair is [string, Json] => isRecord(pair[1])),
  );
}

function records(raw: unknown): Json[] {
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function text(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}
