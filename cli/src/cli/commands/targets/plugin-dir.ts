import { join } from "node:path";
import { quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { exists } from "#core/fs/tree.ts";
import { readLock } from "#core/lock.ts";
import { roots as scopeRoots } from "#core/store/paths.ts";
import { mergedPlugin, mergesWrapped, resolveTargets } from "#core/target/index.ts";

/**
 * Prints the folder a target loads a registry's namespaces from, as one plugin: the command a
 * marketplace entry names, which the target runs at install and at the start of each session.
 */
export async function pluginDir(
  context: CommandContext,
  registry: string | undefined,
): Promise<void> {
  if (registry === undefined) {
    throw new AiregError("`aireg targets plugin-dir` needs a registry.", {
      code: ErrorCode.Usage,
      hint: "Name the registry: `aireg targets plugin-dir <registry>`.",
    });
  }
  const roots = scopeRoots("user", context.cwd);
  for (const target of Object.values(resolveTargets())) {
    if (!mergesWrapped(target, roots.scope)) continue;
    const folder = mergedPlugin(target, registry, roots.scope, roots.cwd);
    const manifest = target.kinds.plugin?.manifest?.[0]?.path;
    if (folder === undefined || manifest === undefined) continue;
    if (!(await exists(join(folder, manifest)))) continue;
    if (context.printer.format === "json") {
      context.printer.json({ ok: true, data: { registry, target: target.name, path: folder } });
    } else context.printer.info(folder);
    return;
  }
  const installed = Object.keys((await readLock(roots)).registries);
  throw new AiregError(`No plugin holds the registry ${quoted(registry)} in your user scope.`, {
    code: ErrorCode.NotFound,
    hint:
      installed.length === 0
        ? "Run `aireg add -g <registry>` to install a registry's artifacts."
        : "Run `aireg sync -g` to bring your user scope up to date.",
  });
}
