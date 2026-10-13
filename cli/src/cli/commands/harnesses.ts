import { noArguments, parse } from "#cli/options.ts";
import { foundBy } from "#cli/render/found.ts";
import { sharedReads } from "#cli/render/tools.ts";
import { detectAll, resolveHarnesses } from "#core/harness/index.ts";
import { table } from "#core/term/table.ts";
import { builtin, type CommandContext } from "./index.ts";

/** Each harness and what detected it: env, binary, then directories. */
export async function run(context: CommandContext): Promise<void> {
  const { positionals } = parse(context.argv, builtin("harnesses"));
  noArguments(positionals, "harnesses");
  // Every name `--for` takes; a shared folder such as `.agents` is never detected.
  const harnesses = resolveHarnesses();
  const rows = detectAll(harnesses, context.cwd);
  const tools = rows.filter((item) => !item.target.shared);
  // The shared folder last: it is not a coding agent, and is always installed into when asked.
  const ordered = [...tools, ...rows.filter((item) => item.target.shared)];

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        harnesses: ordered.map((item) => ({
          name: item.target.name,
          displayName: item.target.displayName,
          shared: item.target.shared,
          detected: item.detected,
          by: item.by,
        })),
      },
    });
    return;
  }

  const { style } = context.printer;
  // The shared folder is not a tool: a person picks the tools, and the note says who reads it.
  table(
    context.printer,
    [
      { header: "harness", value: (item: (typeof rows)[number]) => item.target.displayName },
      { header: "id", value: (item: (typeof rows)[number]) => style.dim(item.target.name) },
      {
        header: "status",
        value: (item: (typeof rows)[number]) =>
          item.detected ? style.green("found") : style.dim("not found"),
      },
      {
        header: "where",
        value: (item: (typeof rows)[number]) => style.dim(item.detected ? foundBy(item.by) : ""),
      },
    ],
    tools,
  );
  context.printer.info();
  for (const line of sharedReads(harnesses)) context.printer.info(line);
  context.printer.info(foundSummary(tools.filter((item) => item.detected).length, tools.length));
}

export function foundSummary(found: number, supported: number): string {
  if (found === 0) return "No supported harness found on this machine.";
  const which = found === supported ? `all ${supported}` : `${found} of ${supported}`;
  return `Found ${which} supported harnesses on this machine.`;
}
