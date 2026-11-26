import type { McpEntry, Value } from "./model.ts";

/** A secret as the variable it is read from. */
export function shownValue(value: Value): string {
  if (typeof value === "string") return value;
  return value.map((part) => (typeof part === "string" ? part : `$${part.secret}`)).join("");
}

const PLAIN = /^[A-Za-z0-9@%+=:,./_-]+$/;

/** Quoted as a POSIX shell would need it, so `sh -c 'a | b'` reads as one argument. */
function quote(text: string): string {
  return PLAIN.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** How the entry runs, as one line a person can check: its environment, command and arguments. */
export function runLine(entry: McpEntry): string {
  if (entry.transport !== "stdio") {
    const headers = Object.keys(entry.headers);
    const sent = headers.length === 0 ? "" : ` with ${headers.join(", ")}`;
    return `${shownValue(entry.url)} (${entry.transport})${sent}`;
  }
  const env = Object.entries(entry.env).map(([name, value]) => `${name}=${quoteValue(value)}`);
  return [...env, quote(entry.command), ...entry.args.map(quoteValue)].join(" ");
}

/** Literal text quoted; a secret stays a variable the shell would read, as the target does. */
function quoteValue(value: Value): string {
  if (typeof value === "string") return quote(value);
  const inner = value
    .map((part) =>
      typeof part === "string" ? part.replace(/["\\$`]/g, "\\$&") : `$${part.secret}`,
    )
    .join("");
  return `"${inner}"`;
}
