import { basename, resolve } from "node:path";
import { expandHome } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { type LockedSkill, readSkillLock } from "#cli/commands/add/skill-lock.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { addAddress } from "./from-address.ts";
import type { Parsed } from "./options.ts";

/**
 * Adds what another installer's lock file records, one source at a time, taking over each copy
 * already on disk that holds exactly what aireg installs.
 */
export async function addFrom(
  context: CommandContext,
  parsed: Parsed,
  from: string,
): Promise<void> {
  const { positionals, common, own } = parsed;
  if (positionals.length > 0 || own.registry !== undefined || common.select !== undefined) {
    throw new AiregError("`aireg add --from` takes no address and no -s.", {
      code: ErrorCode.Usage,
      hint: "Run `aireg add --from <file>` on its own: the file says what to add.",
    });
  }
  const lock = await readSkillLock(resolve(context.cwd, expandHome(from)));
  for (const skipped of lock.skipped) context.printer.warning(skipped);
  if (lock.skills.length === 0) {
    throw new AiregError(`${from} records no skill aireg can add.`, { code: ErrorCode.NotFound });
  }
  const sources = new Map<string, LockedSkill[]>();
  for (const skill of lock.skills) {
    const key = `${skill.address}\u0000${skill.ref ?? ""}`;
    sources.set(key, [...(sources.get(key) ?? []), skill]);
  }
  const scope = common.scope ?? (lock.user ? "user" : undefined);
  for (const skills of sources.values()) {
    const [first] = skills as [LockedSkill, ...LockedSkill[]];
    for (const skill of skills) {
      const folder = skill.folder === "." ? undefined : basename(skill.folder);
      if (folder !== undefined && folder !== skill.name) {
        context.printer.warning(
          `${quoted(skill.name)} installs as ${quoted(folder)}, the name of its folder, so a copy under ${quoted(skill.name)} stays as it is.`,
        );
      }
    }
    const names = skills.map((skill) =>
      skill.folder === "." ? skill.name : basename(skill.folder),
    );
    await addAddress(
      context,
      {
        positionals: [first.address],
        common: { ...common, scope, select: names },
        own: { ...own, from: undefined, ...(first.ref === undefined ? {} : { ref: first.ref }) },
      },
      new Set(names),
    );
  }
}
