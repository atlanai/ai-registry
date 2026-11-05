import { sanitizeBlock } from "#adapter/text.ts";

/** One GitHub Actions workflow command line, such as `::error file=a,title=b::message`. */
export function workflowCommand(
  command: string,
  properties: Readonly<Record<string, string>>,
  message: string,
): string {
  const list = Object.entries(properties).map(([key, value]) => `${key}=${property(value)}`);
  return `::${command}${list.length === 0 ? "" : ` ${list.join(",")}`}::${data(message)}`;
}

function property(value: string): string {
  return data(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

// The escaping @actions/core applies: a raw newline in a value would start a command of its own.
function data(value: string): string {
  return sanitizeBlock(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
