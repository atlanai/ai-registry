import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type PublishInput,
  type PublishOptions,
  type PublishResult,
  REGISTRY_DOCUMENT,
  type Resolution,
  registryNameFromLocation,
  registryPath,
  type SourceContext,
  type SourceHandle,
  type Want,
} from "#adapter/index.ts";
import { isLayoutId, isReadOnlyLayout, type LayoutId } from "#adapter/layouts/ids.ts";
import { detectLayout, openLayoutRoot } from "#adapter/layouts/open.ts";
import { fail, translating } from "./errors.ts";
import { writeOffer } from "./publish.ts";

export async function connect(context: SourceContext): Promise<SourceHandle> {
  const root = context.source.location;
  if (!isAbsolute(root)) {
    throw fail("invalid", `${root} was not expanded to an absolute path.`);
  }
  if (!existsSync(root)) throw fail("not_found", `The folder ${root} does not exist.`);
  // A bare repository has no working tree to read; git reads it by URL.
  if (
    !existsSync(join(root, REGISTRY_DOCUMENT)) &&
    existsSync(join(root, "HEAD")) &&
    existsSync(join(root, "objects"))
  ) {
    throw fail("invalid", `${root} is a bare git repository.`, {
      hint: `Add it by its URL instead: ${pathToFileURL(root).href}`,
    });
  }

  await translating(() => registryPath(root, "", true));
  const forced = layoutOf(context);
  const files = openLayoutRoot();
  // What a folder of skills is filed under: the name its path suggests, whatever it was added as.
  const namespace = registryNameFromLocation(root, "skills");
  const { registry } = context.source;

  // A version folder is already content the spec describes, so it is copied from where it sits,
  // never staged into a second store; a publish writes in place, for the next resolve to read.
  return {
    resolve: (want, options): Promise<Resolution> =>
      translating(async () => {
        const resolution = await files.resolve(root, want, {
          all: options?.all,
          layout: forced,
          context: { namespace, rootName: namespace },
        });
        if (isReadOnlyLayout(resolution.layout)) refuseVersions(registry, want);
        return resolution;
      }),

    localRoot: (artifact) => translating(() => files.localRoot(artifact)),

    fetch: (artifact, file) => translating(() => files.fetch(artifact, file)),

    async publish(
      changes: readonly PublishInput[],
      options?: PublishOptions,
    ): Promise<PublishResult> {
      return translating(async () => {
        // Refused before anything is written: aireg only reads a folder of skills.
        // Undetectable is not read-only; the publish itself then says what is wrong.
        const layout = forced ?? (await detectLayout(root).catch(() => undefined));
        if (isReadOnlyLayout(layout)) {
          throw fail(
            "invalid",
            `${registry} is a folder of skills, not a registry, so aireg reads it but does not publish to it.`,
            {
              hint: "Publish to a registry of your own: create one with `aireg registry init <folder>`.",
            },
          );
        }
        const written = await writeOffer(
          root,
          changes,
          new Date().toISOString(),
          context.exclusive,
          options?.partial === true,
        );
        files.forget();
        const { unchanged, refused } = written;
        return { unchanged, location: root, ...(refused.length === 0 ? {} : { refused }) };
      });
    },

    async close(): Promise<void> {},
  };
}

/** The layout the manifest recorded or `--layout` forced; undefined detects it. */
function layoutOf(context: SourceContext): LayoutId | undefined {
  const named = context.source.config.layout;
  if (named === undefined) return undefined;
  if (!isLayoutId(named)) throw fail("invalid", `${named} is not a layout this adapter reads.`);
  return named;
}

/** A folder of skills has no versions: what it holds now is all there is, named by its content. */
function refuseVersions(registry: string, want: readonly Want[]): void {
  const pinned = want.find((item) => item.version !== undefined);
  if (pinned === undefined) return;
  throw fail(
    "invalid",
    `${registry} is a folder of skills, which has no versions, so ${pinned.name}@${pinned.version} cannot be installed.`,
    {
      artifact: pinned.name,
      hint: "Leave off the `@<version>`: aireg installs what the folder holds now.",
    },
  );
}
