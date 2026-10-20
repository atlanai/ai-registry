import { frontmatterRecord, markdownBody } from "#core/catalog/frontmatter.ts";
import { multilineQuote, quote } from "#core/harness/register/toml.ts";
import type { Rendered } from "./index.ts";

export function frontmatterToml(source: string, fields: readonly string[], body: string): Rendered {
  const record = frontmatterRecord(source);
  if (record === undefined) return { problem: "it has no front matter" };
  const lines: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") return { problem: `it has no ${field}` };
    lines.push(`${field} = ${quote(value)}`);
  }
  const instructions = markdownBody(source).replace(/\r\n/g, "\n").trim();
  if (instructions === "") return { problem: "it has no instructions" };
  lines.push(`${body} = ${multilineQuote(instructions)}`);
  return { text: `${lines.join("\n")}\n` };
}
