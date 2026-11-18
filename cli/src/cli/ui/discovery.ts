import type { CommandContext } from "#cli/commands/command.ts";
import { discoveryCatalog } from "#cli/discovery/catalog.ts";
import { discover } from "#core/discovery/actions.ts";
import { type Discovery, safeError } from "#core/discovery/service.ts";

/** HTTP only adapts the shared operation's envelope and schedules background indexing. */
export async function discoveryRoute(
  service: Discovery,
  context: CommandContext,
  action: string,
  payload: Record<string, unknown>,
): Promise<[number, object]> {
  try {
    return [
      200,
      {
        ok: true,
        data: await discover(service, action, payload, discoveryCatalog(context), true),
      },
    ];
  } catch (error) {
    return [400, { ok: false, error: safeError(error) }];
  }
}
