import { join } from "node:path";
import { DEFAULT_BLOB_URL, readRegistry } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import {
  INDEX_DOCUMENT,
  isArtifactName,
  isDeviceName,
  isKindSegment,
  isNamespace,
  REGISTRY_DOCUMENT,
} from "#adapter/filespec/names.ts";
import { isVersion } from "#adapter/spec/ref.ts";
import { quoted } from "#adapter/text.ts";
import { versionFolders } from "#core/filespec/indexer.ts";
import { kindsOf, manifestProblems } from "#core/filespec/kind-manifests.ts";
import { subdirectories } from "#core/fs/tree.ts";
import { baseDiff, droppedReleases, releasedChanges } from "./base.ts";
import { catalogProblems } from "./catalog.ts";
import { folderProblems, newestFolders } from "./folders.ts";
import { jsonAt, type Problem } from "./read.ts";

export interface Validated {
  name: string;
  namespaces: number;
  artifacts: number;
  versions: number;
  problems: Problem[];
}

/**
 * Everything a pull request could get wrong: path grammar, documents, digests, kind manifests,
 * released versions left alone, and an index matching what the indexer would write.
 */
export async function validateRoot(
  root: string,
  options: { base?: string | undefined } = {},
): Promise<Validated> {
  const problems: Problem[] = [];
  let name = "registry";
  let blobUrl = DEFAULT_BLOB_URL;
  try {
    const registry = await readRegistry(rootReader(root));
    name = registry.slug ?? registry.name;
    blobUrl = registry.blobUrl;
    if (!registry.capabilities.includes("files")) {
      problems.push({ path: REGISTRY_DOCUMENT, message: 'capabilities must include "files"' });
    }
  } catch (error) {
    problems.push({ path: REGISTRY_DOCUMENT, message: (error as Error).message });
  }
  const index = await jsonAt(root, INDEX_DOCUMENT, problems);
  if (index === undefined && !problems.some((p) => p.path === INDEX_DOCUMENT)) {
    problems.push({ path: INDEX_DOCUMENT, message: "is missing", fix: "aireg registry index" });
  }

  await layout(root, problems);
  const kinds = await kindsOf(root);
  problems.push(...(await manifestProblems(root)));
  const diff = options.base === undefined ? undefined : await baseDiff(root, options.base);
  const released = diff === undefined ? new Map() : await releasedChanges(diff);
  if (diff !== undefined) problems.push(...(await droppedReleases(root, diff)));
  const folders = await versionFolders(root);
  const held = new Set(
    folders.map((folder) => `${folder.namespace}/${folder.kind}/${folder.name}@${folder.version}`),
  );
  const newest = newestFolders(folders);
  const artifacts = new Set<string>();
  const namespaces = new Set<string>();
  const listings = new Map<string, Map<string, unknown>>();
  let stale = false;

  for (const folder of folders) {
    namespaces.add(folder.namespace);
    artifacts.add(`${folder.namespace}/${folder.kind}/${folder.name}`);
    const checked = await folderProblems(root, folder, {
      kinds,
      held,
      released,
      listings,
      blobUrl,
      restoreFrom: diff?.ref ?? "HEAD",
      newest,
    });
    problems.push(...checked.problems);
    if (checked.stale) stale = true;
  }

  const listedIn = new Set(
    (
      ((index as { entries?: unknown } | undefined)?.entries ?? []) as {
        namespace?: string;
        kind?: string;
        name?: string;
      }[]
    ).map((entry) => `${entry.namespace}/${entry.kind}/${entry.name}`),
  );
  for (const artifact of artifacts) if (!listedIn.has(artifact)) stale = true;
  problems.push(...(await catalogProblems(root, held, index)));
  if (stale) {
    problems.push({ path: INDEX_DOCUMENT, message: "is out of date", fix: "aireg registry index" });
  }

  return {
    name,
    namespaces: namespaces.size,
    artifacts: artifacts.size,
    versions: folders.length,
    problems,
  };
}

/** Every folder under `artifacts/` the path grammar refuses, named at the level it breaks. */
async function layout(root: string, problems: Problem[]): Promise<void> {
  const levels: [(value: string) => boolean, string][] = [
    [isNamespace, "a namespace"],
    [isKindSegment, "a kind"],
    [isArtifactName, "a name: lowercase letters, digits and hyphens"],
    [isVersion, "a version"],
  ];
  async function visit(dir: string, rel: string, depth: number): Promise<void> {
    const level = levels[depth];
    if (level === undefined) return;
    for (const child of await subdirectories(dir)) {
      const at = `${rel}/${child}`;
      if (isDeviceName(child)) {
        problems.push({ path: at, message: `${quoted(child)} is a device name on Windows` });
        continue;
      }
      if (!level[0](child)) {
        problems.push({ path: at, message: `${quoted(child)} is not ${level[1]}` });
        continue;
      }
      await visit(join(dir, child), at, depth + 1);
    }
  }
  await visit(join(root, "artifacts"), "artifacts", 0);
}
