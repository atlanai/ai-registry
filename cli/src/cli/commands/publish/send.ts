import type { PublishResult } from "#adapter/index.ts";
import { plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import type { Interaction } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { text } from "#cli/prompt/text.ts";
import { trackPublish } from "#cli/telemetry/events.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import {
  commitAndPush,
  heldUnlisted,
  type Planned,
  type Published,
  releaseSubject,
} from "#engine/publish/target.ts";

/** `options.checkout` is where to `cd` to commit, when the registry folder is a git checkout. */
export async function sendTo(
  printer: CommandContext["printer"],
  step: Interaction,
  alias: string,
  items: Planned[],
  opened: Published,
  options: { message: string | undefined; asked: boolean; checkout: string | undefined },
): Promise<PublishResult | undefined | "canceled"> {
  const { adapter, handle } = opened.source;
  if (options.message !== undefined && adapter.capabilities.messages !== true) {
    printer.hint(
      options.checkout !== undefined
        ? "A registry folder keeps no change message, so -m was not used. Put it in your git commit instead."
        : `${alias} keeps no change message, so -m was not used.`,
    );
  }
  let message = options.message ?? subjectOf(items);
  if (options.asked) {
    const typed = await text(
      {
        message: "What changed?",
        style: printer.errStyle,
        initial: message,
        hint: "Type what changed, or press Enter to use this message.",
      },
      step.io,
    );
    if (canceled(typed)) return "canceled";
    message = typed;
  }
  const published = await handle
    .publish?.(
      items.map((item) => item.input),
      { message, review: true },
    )
    .catch((error: unknown) => {
      throw heldUnlisted(error, alias, items);
    });
  trackPublish(
    { location: opened.location, adapter: adapter.id },
    items.map((item) => item.work),
  );
  const what = items.length === 1 ? items[0]?.work.name : plural(items.length, "artifact");
  printer.success(published?.summary ?? `Published ${what} to ${alias}.`);
  for (const note of published?.notes ?? []) printer.info(`  ${note}`);
  if (options.checkout !== undefined)
    printer.note("next", commitAndPush(message, options.checkout));
  else if (published?.summary === undefined) {
    printer.note(
      "when",
      `background jobs within ${DEFAULT_INTERVAL_WORDS}, projects on \`aireg update\``,
    );
  }
  return published;
}

/** What the change is, in the words a commit or a changelog would use. */
function subjectOf(items: readonly Planned[]): string {
  return releaseSubject(
    items.map((item) => ({
      name: item.work.name,
      version: item.version,
      first: item.from === undefined,
    })),
  );
}
