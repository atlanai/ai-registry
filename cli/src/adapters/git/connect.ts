import { posix } from "node:path";
import {
  isSafePath,
  type Resolution,
  registryNameFromLocation,
  registryPath,
  type SourceContext,
  type SourceHandle,
  type Want,
} from "#adapter/index.ts";
import { isLayoutId, type LayoutId } from "#adapter/layouts/ids.ts";
import { detectLayout, openLayoutRoot } from "#adapter/layouts/open.ts";
import { list } from "#adapter/text.ts";
import { fail, translating } from "./errors.ts";
import { GitError, type GitLimits } from "./exec.ts";
import { pluginFetcher } from "./plugins.ts";
import { resolveRef } from "./resolve.ts";
import { holdSnapshot, snapshot } from "./snapshot.ts";
import { parseSource } from "./url.ts";
import { GitVersions, releaseTag } from "./versions.ts";

/**
 * A repository that is a file spec root, or a plain folder of skills. The clone is only a cache,
 * so this is a layout's reader over a checkout plus a revision to pin.
 */
export async function connect(context: SourceContext): Promise<SourceHandle> {
  const spec = parseSource(context.source.location);
  if (spec.kind !== "git") {
    throw fail("invalid", `${context.source.location} is not a repository.`);
  }

  const ref = context.source.config.ref ?? spec.ref;
  const folder = context.source.config.path ?? spec.path ?? "";
  if (folder !== "" && !isSafePath(folder)) {
    throw fail("invalid", `${folder} is not a folder inside the repository.`);
  }
  const forced = layoutOf(context);
  // A checkout is one commit, so what it lists never changes.
  const files = openLayoutRoot({ immutable: true });
  const limits: GitLimits = {
    timeoutMs: context.limits.timeoutMs,
    timeoutSetting: context.limits.timeoutSetting,
    signal: context.signal,
  };
  const versions = new GitVersions({
    spec,
    limits,
    cacheDir: () => context.cacheDir(),
    exclusive: context.exclusive,
  });
  const namespace = registryNameFromLocation(spec.location, spec.alias);
  const layoutContext = {
    namespace,
    rootName: folder === "" ? namespace : posix.basename(folder),
  };
  const held: (() => void)[] = [];

  const checkout = async (commit: string, asked: string | undefined) => {
    const placed = await snapshot(() => context.cacheDir(), spec, asked, commit, limits);
    held.push(holdSnapshot(placed.root));
    return { root: await registryPath(placed.root, folder, true), commit: placed.commit ?? commit };
  };

  // Not a registry: one commit, chosen by the versions asked for, the ref, or the newest release.
  const targetOf = async (want: readonly Want[]): Promise<string> => {
    // A want with its own revision is a fetched plugin's, whose version is its own repository's.
    const pinned = want.filter((item) => item.version !== undefined && item.revision === undefined);
    if (pinned.length > 0) {
      const commits = await Promise.all(
        pinned.map(async (item) => ({
          item,
          commit: await versions.commitOf(item.version as string, item.name),
        })),
      );
      const distinct = [...new Set(commits.map((entry) => entry.commit))];
      if (distinct.length > 1) {
        const named = commits.map(({ item }) => `${item.name}@${item.version}`);
        throw new GitError(
          "invalid",
          `${list(named)} are at different commits of ${spec.location}, which aireg reads at one commit.`,
          "",
          "Pin them all to one version, or leave the versions off to take the newest.",
        );
      }
      return distinct[0] as string;
    }
    if (ref !== undefined) return (await resolveRef(spec, ref, limits)).commit;
    const release = releaseTag(await versions.tags());
    if (release !== undefined) return release.tag.commit;
    return (await resolveRef(spec, undefined, limits)).commit;
  };

  const readLayout = async (
    layout: LayoutId,
    want: readonly Want[],
    all: boolean | undefined,
  ): Promise<Resolution> => {
    const target = await targetOf(want);
    const at = await checkout(target, target);
    const fetch = pluginFetcher(context, limits, held, want);
    const resolution = await files.resolve(at.root, want, {
      all,
      layout,
      context: { ...layoutContext, fetch },
    });
    const names = resolution.artifacts.map((artifact) => artifact.envelope.metadata.name);
    const served = await versions.versionsAt(at.commit, names, at.root);
    return {
      ...resolution,
      artifacts: resolution.artifacts.map((artifact) => ({
        ...artifact,
        version: artifact.version ?? served.get(artifact.envelope.metadata.name),
      })),
      sourceRevision: at.commit,
    };
  };

  return {
    resolve: (want, options): Promise<Resolution> =>
      translating(async () => {
        if (forced !== undefined && forced !== "registry") {
          return readLayout(forced, want, options?.all);
        }
        // A registry is read at its ref, or the default branch, never at a release tag.
        const resolved = await resolveRef(spec, ref, limits);
        const at = await checkout(resolved.commit, ref);
        const layout = forced ?? (await detectLayout(at.root));
        if (layout !== "registry") return readLayout(layout, want, options?.all);
        const resolution = await files.resolve(at.root, want, {
          all: options?.all,
          layout,
          context: layoutContext,
        });
        // The revision pins the source, not the content, so an unrelated commit
        // cannot re-identify bytes that never moved.
        return { ...resolution, sourceRevision: at.commit };
      }),

    localRoot: (artifact) => translating(() => files.localRoot(artifact)),

    fetch: (artifact, file) => translating(() => files.fetch(artifact, file)),

    async close(): Promise<void> {
      for (const release of held.splice(0)) release();
    },
  };
}

/** The layout the manifest recorded or `--layout` forced; undefined detects it. */
function layoutOf(context: SourceContext): LayoutId | undefined {
  const named = context.source.config.layout;
  if (named === undefined) return undefined;
  if (!isLayoutId(named)) throw fail("invalid", `${named} is not a layout this adapter reads.`);
  return named;
}
