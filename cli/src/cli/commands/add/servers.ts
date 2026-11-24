import { list, plural, quoted } from "#adapter/text.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { confirm } from "#cli/prompt/select.ts";
import { describeServer, serverOf } from "#cli/render/server.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { parseRef } from "#core/ref.ts";
import type { Probed } from "#engine/address/probe.ts";

/**
 * A whole namespace or registry takes its MCP servers only once a person saw how each starts,
 * since a target runs it as them; `--yes` agrees without asking.
 */
export async function confirmServers(
  step: Interaction,
  source: Probed,
  chosen: readonly Entry[],
  refs: readonly string[],
  yes: boolean,
): Promise<boolean> {
  const named = new Set(refs.flatMap((text) => parseRef(text).name ?? []));
  const servers = chosen.filter((entry) => entry.kind === "mcp_server" && !named.has(entry.name));
  if (servers.length === 0 || yes) return true;
  const names = list(servers.map((entry) => quoted(entry.name)));
  if (!interactive(step)) {
    throw new AiregError(
      `${names} ${servers.length === 1 ? "is an MCP server" : "are MCP servers"}, which a target starts as you.`,
      {
        code: ErrorCode.Usage,
        hint: "Run `aireg show` on each to see how it starts, then add again with `--yes`, or name the artifacts to add.",
      },
    );
  }
  for (const entry of servers) {
    step.printer.info(entry.name);
    describeServer(step.printer, await serverOf(await source.stage(entry)));
  }
  const answer = await confirm(
    {
      message: `Install ${plural(servers.length, "MCP server")}, which a target starts as you?`,
      style: step.printer.errStyle,
      initial: false,
    },
    step.io,
  );
  return !canceled(answer) && answer;
}
