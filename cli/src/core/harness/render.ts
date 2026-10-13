import { frontmatterRecord, markdownBody } from "#core/catalog/frontmatter.ts";
import { multilineQuote, quote } from "#core/harness/register/toml.ts";
import type { Render } from "./contract.ts";

/** The bytes a rendered placement holds, or why it has none. */
export type Rendered = { text: string } | { problem: string };

export function renderPlacement(render: Render, source: string): Rendered {
  const record = frontmatterRecord(source);
  if (record === undefined) return { problem: "it has no front matter" };
  const lines: string[] = [];
  for (const field of render.fields) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") return { problem: `it has no ${field}` };
    lines.push(`${field} = ${quote(value)}`);
  }
  const body = markdownBody(source).replace(/\r\n/g, "\n").trim();
  if (body === "") return { problem: "it has no instructions" };
  lines.push(`${render.body} = ${multilineQuote(body)}`);
  return { text: `${lines.join("\n")}\n` };
}
