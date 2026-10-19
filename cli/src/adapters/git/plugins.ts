import { isSafePath, quoted, registryPath, type SourceContext, type Want } from "#adapter/index.ts";
import type { FetchedPlugin, RemotePlugin } from "#adapter/layouts/layout.ts";
import { fail } from "./errors.ts";
import type { GitLimits } from "./exec.ts";
import { resolveRef } from "./resolve.ts";
import { holdSnapshot, snapshot } from "./snapshot.ts";
import { parseSource, type SourceSpec } from "./url.ts";
import { GitVersions } from "./versions.ts";

/** `owner/repo`, which a github source names and a git-subdir one may. */
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

/** Where a plugin source says its repository is, held to the transports a registry may use. */
function specOf(plugin: RemotePlugin): SourceSpec {
  const shorthand = plugin.type !== "url" && SHORTHAND.test(plugin.location);
  if (plugin.type === "github" && !shorthand) {
    throw fail("invalid", `its repo, ${quoted(plugin.location)}, is not owner/repo`);
  }
  if (/^(http|git):\/\//i.test(plugin.location)) {
    throw fail("invalid", `${quoted(plugin.location)} has no transport security`);
  }
  const spec = parseSource(shorthand ? `github.com/${plugin.location}` : plugin.location);
  if (spec.kind !== "git") throw fail("invalid", `${quoted(plugin.location)} is not a repository`);
  return spec;
}

/**
 * Fetches each plugin a marketplace lists by repository, at its own commit: the entry's sha,
 * else the commit the lockfile holds for it, else its ref now. Nothing a source names is run.
 */
export function pluginFetcher(
  context: Pick<SourceContext, "cacheDir" | "exclusive">,
  limits: GitLimits,
  held: (() => void)[],
  wanted: readonly Want[],
): (plugin: RemotePlugin) => Promise<FetchedPlugin> {
  return async (plugin) => {
    const spec = specOf(plugin);
    if (plugin.path !== undefined && !isSafePath(plugin.path)) {
      throw fail(
        "invalid",
        `its path, ${quoted(plugin.path)}, is not a folder inside the repository`,
      );
    }
    const locked = wanted.find((want) => want.name === plugin.name && want.revision !== undefined);
    const commit =
      plugin.sha ?? locked?.revision ?? (await resolveRef(spec, plugin.ref, limits)).commit;
    const placed = await snapshot(() => context.cacheDir(), spec, commit, commit, limits);
    held.push(holdSnapshot(placed.root));
    const root = await registryPath(placed.root, plugin.path ?? "", true);
    const versions = new GitVersions({
      spec,
      limits,
      cacheDir: () => context.cacheDir(),
      exclusive: context.exclusive,
    });
    const at = placed.commit ?? commit;
    const version = (await versions.versionsAt(at, [plugin.name], placed.root)).get(plugin.name);
    return { root, revision: at, version };
  };
}
