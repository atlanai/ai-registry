import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ifPresent } from "#adapter/files.ts";
import { MCP_SERVER_ENTRY } from "#adapter/kinds.ts";
import { sanitizeText } from "#adapter/text.ts";
import type { ShownServer } from "#cli/commands/show/result.ts";
import type { Value } from "#core/mcp/model.ts";
import { resolveServer } from "#core/mcp/resolve.ts";
import type { Printer } from "#core/term/printer.ts";

/** How the server would run, with a required input nothing sets shown as `<name>`. */
export async function serverOf(dir: string): Promise<ShownServer> {
  const text = await ifPresent(readFile(join(dir, MCP_SERVER_ENTRY), "utf8"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    parsed = undefined;
  }
  const { options, leftOut } = resolveServer(parsed, { placeholders: true });
  return {
    runs: options.map(({ entry }) =>
      entry.transport === "stdio"
        ? {
            transport: entry.transport,
            command: [entry.command, ...entry.args].map(shown).join(" "),
          }
        : { transport: entry.transport, url: shown(entry.url) },
    ),
    reads: [...new Set(options.flatMap((option) => option.secrets))].sort(),
    leftOut,
  };
}

/** A secret as the variable it is read from. */
function shown(value: Value): string {
  if (typeof value === "string") return value;
  return value.map((part) => (typeof part === "string" ? part : `$${part.secret}`)).join("");
}

/** After the body, since how it starts is what a person checks before installing it. */
export function describeServer(printer: Printer, server: ShownServer): void {
  for (const run of server.runs) {
    printer.note("runs", sanitizeText(run.command ?? `${run.url ?? ""} (${run.transport})`));
  }
  if (server.reads.length > 0)
    printer.note("reads", server.reads.map((name) => sanitizeText(name)).join(", "));
  for (const reason of server.leftOut) printer.note("skips", sanitizeText(reason));
}
