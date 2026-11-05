import { list, sanitizeText, withoutCredentials } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { type Interaction, interactive } from "./interaction.ts";
import { canceled } from "./model.ts";
import { select } from "./select.ts";

/**
 * With nothing named, a terminal offers what is declared; anywhere else that
 * is a usage error, because there is nobody to ask.
 */
export async function chooseRegistry(
  step: Interaction,
  known: Readonly<Record<string, RegistrySource>>,
  ask: { message: string; missing: string; usage: (aliases: string) => string } = {
    message: "Install from which registry?",
    missing: "`aireg add` needs a registry.",
    usage: (aliases) => `Name the registry: \`aireg add <registry>\`, such as ${aliases}.`,
  },
): Promise<string | undefined> {
  const aliases = Object.keys(known).sort();
  if (!interactive(step) || aliases.length === 0) {
    throw new AiregError(ask.missing, {
      code: ErrorCode.Usage,
      hint:
        aliases.length === 0
          ? "Declare one first with `aireg registry add <address>`, such as github.com/owner/repo or a folder."
          : ask.usage(list(aliases, "or")),
    });
  }
  // A cloned project's manifest can put line breaks and escapes in an address.
  const picked = await select<string>(
    {
      message: ask.message,
      style: step.printer.errStyle,
      initial: aliases[0] as string,
      options: aliases.map((alias) => ({
        value: alias,
        label: alias,
        hint: sanitizeText(withoutCredentials(known[alias]?.location ?? "")),
      })),
    },
    step.io,
  );
  return canceled(picked) ? undefined : picked;
}
