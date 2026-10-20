import { type Artifact, covers, type FileRef, type Resolution, type Want } from "../contract.ts";
import { readJson, SpecError } from "../filespec/documents.ts";
import { openFolderRegistry, registryPath, rootReader } from "../filespec/folder.ts";
import { REGISTRY_DOCUMENT } from "../filespec/names.ts";
import { besideEnvelope } from "../filespec/resolve.ts";
import { list } from "../text.ts";
import { folderLayout, ROOT_ID } from "./folder.ts";
import type { LayoutId } from "./ids.ts";
import type { Found, Layout, LayoutContext } from "./layout.ts";
import { marketplaceLayout } from "./marketplace.ts";
import { openTree, type Tree } from "./tree.ts";

/** Tried in order: the first that matches reads the source. */
const LAYOUTS: readonly Layout[] = [marketplaceLayout, folderLayout];

/** A registry is the file spec's own layout, read by the file spec reader. */
async function isRegistry(root: string): Promise<boolean> {
  // A registry.json that is there but unreadable is a broken registry, never another layout.
  return (await readJson(rootReader(root), REGISTRY_DOCUMENT)) !== undefined;
}

/** What every layout looks for, so a source none of them reads is told what would make it one. */
function nothingFound(layouts: readonly Layout[]): SpecError {
  const looked = [REGISTRY_DOCUMENT, ...layouts.flatMap((layout) => layout.looksFor)];
  return new SpecError(
    `This source holds nothing aireg reads: no ${list([...new Set(looked)], "or")}.`,
    {
      path: REGISTRY_DOCUMENT,
      hint: "Check the address, or create a registry with `aireg registry init`.",
    },
  );
}

/** The layout of the folder at `root`: the one `forced` names, or the first that matches. */
export async function detectLayout(root: string, forced?: LayoutId): Promise<LayoutId> {
  if (forced !== undefined) return forced;
  if (await isRegistry(root)) return "registry";
  const tree = await openTree(root);
  for (const layout of LAYOUTS) {
    if ((await layout.match(tree)) === "yes") return layout.id;
  }
  throw nothingFound(LAYOUTS);
}

function layoutOf(id: LayoutId): Layout | undefined {
  return LAYOUTS.find((layout) => layout.id === id);
}

/**
 * What the source lists, narrowed to the wants; a want it does not list is left to the caller.
 * A plugin brings its members, which is what a harness without plugins installs instead.
 */
function chosen(found: readonly Artifact[], wanted: readonly Want[], all: boolean): Artifact[] {
  if (all || wanted.length === 0) return [...found];
  const reached = found.filter((artifact) =>
    wanted.some((want) =>
      covers(want, {
        name: artifact.envelope.metadata.name,
        namespace: artifact.group,
        kind: artifact.kind,
      }),
    ),
  );
  const plugins = new Set(
    reached.filter((item) => item.kind === "plugin").map((item) => item.envelope.metadata.name),
  );
  return found.filter(
    (artifact) =>
      reached.includes(artifact) || (artifact.group !== undefined && plugins.has(artifact.group)),
  );
}

/** Whether an artifact is one a want asks for, whatever version the want names. */
const reaches = (want: Want) => (artifact: Artifact) =>
  covers(want, {
    name: artifact.envelope.metadata.name,
    namespace: artifact.group,
    kind: artifact.kind,
  });

/**
 * The plugins fetched from elsewhere that a resolve needs, by entry name: those wanted, or the
 * plugin a wanted skill sits in. Undefined when it needs all of them.
 */
function askedFor(wanted: readonly Want[], all: boolean): ((name: string) => boolean) | undefined {
  if (all || wanted.length === 0) return undefined;
  const names = new Set(wanted.flatMap((want) => [want.name, want.namespace ?? want.name]));
  return (name) => names.has(name);
}

/** How `LayoutRoot.resolve` reads a folder. */
interface LayoutResolveOptions {
  all?: boolean | undefined;
  /** Read it this way, without detecting: what the manifest recorded, or `--layout`. */
  layout?: LayoutId | undefined;
  /** What a layout calls things the source does not name. */
  context: LayoutContext;
}

/** A folder on disk read by its layout: what it resolved, and reading only that. */
export interface LayoutRoot {
  /** Every layout but `registry` ignores a want's version; the adapter settles versions first. */
  resolve(
    root: string,
    wanted: readonly Want[],
    options: LayoutResolveOptions,
  ): Promise<Resolution & { layout: LayoutId }>;
  localRoot(artifact: Artifact): Promise<string | undefined>;
  fetch(artifact: Artifact, file: FileRef): Promise<Uint8Array>;
  /** After a write, nothing resolved before it may be read until the next resolve. */
  forget(): void;
}

/** Layouts other than `registry`, read once per folder that never changes, such as a checkout. */
const SETTLED = new Map<string, Found>();
const SETTLED_LIMIT = 32;

async function enumerated(
  layout: Layout,
  tree: Tree,
  context: LayoutContext,
  immutable: boolean,
): Promise<Found> {
  const key = `${tree.root}\u0000${layout.id}\u0000${JSON.stringify(context)}`;
  const kept = immutable ? SETTLED.get(key) : undefined;
  if (kept !== undefined) return structuredClone(kept);
  const found = await layout.enumerate(tree, context);
  // A fetched plugin may follow a branch, so only what the checkout alone holds is kept, and
  // only a whole reading of it.
  if (immutable && found.roots === undefined && context.asked === undefined) {
    SETTLED.delete(key);
    SETTLED.set(key, structuredClone(found));
    const [oldest] = SETTLED.keys();
    if (SETTLED.size > SETTLED_LIMIT && oldest !== undefined) SETTLED.delete(oldest);
  }
  return found;
}

/**
 * For any adapter whose source ends up as a folder on disk. A registry reads through the file
 * spec as `openFolderRegistry` does; any other layout is read from its files, and is read-only.
 */
export function openLayoutRoot(options: { immutable?: boolean } = {}): LayoutRoot {
  const registry = openFolderRegistry(options);
  let root: string | undefined;
  let read: LayoutId | undefined;
  const listed = new Map<string, Artifact>();
  let roots = new Map<string, string>();

  const within = (artifact: Artifact): string => {
    if (root === undefined || !listed.has(artifact.id)) {
      throw new SpecError(`${artifact.id} is not in the source's current listing.`, {
        path: artifact.id,
        missing: true,
        artifact: artifact.id,
      });
    }
    return root;
  };

  return {
    async resolve(at, wanted, resolveOptions) {
      await registryPath(at, "", true);
      const layout = await detectLayout(at, resolveOptions.layout);
      root = at;
      read = layout;
      listed.clear();
      roots = new Map();
      if (layout === "registry") {
        return { ...(await registry.resolve(at, wanted, resolveOptions.all)), layout };
      }
      const reader = layoutOf(layout);
      if (reader === undefined) throw new SpecError(`aireg cannot read the ${layout} layout here.`);
      const tree = await openTree(at);
      const immutable = options.immutable === true;
      const asked = askedFor(wanted, resolveOptions.all === true);
      let found = await enumerated(reader, tree, { ...resolveOptions.context, asked }, immutable);
      // A want no entry's name reaches, such as a plugin known by another name, reads them all.
      if (asked !== undefined && !wanted.every((want) => found.artifacts.some(reaches(want)))) {
        found = await enumerated(reader, tree, resolveOptions.context, immutable);
      }
      // Forced, a layout that finds nothing says what it looked for, as detection does.
      if (found.artifacts.length === 0) throw nothingFound([reader]);
      const artifacts = chosen(found.artifacts, wanted, resolveOptions.all === true);
      for (const artifact of artifacts) listed.set(artifact.id, artifact);
      roots = found.roots ?? new Map();
      return {
        artifacts,
        registry: { name: found.name ?? resolveOptions.context.namespace },
        ...(found.warnings.length === 0 ? {} : { warnings: found.warnings }),
        layout,
      };
    },

    async localRoot(artifact) {
      if (read === "registry") return registry.localRoot(artifact);
      const at = within(artifact);
      // A fetched plugin lies outside the source, so it is copied into the store from its checkout.
      if (roots.has(artifact.id)) return undefined;
      // A skill's folder is read where it lies, only what its envelope describes copied out.
      if (artifact.id === ROOT_ID) return at;
      return besideEnvelope(artifact) ? registryPath(at, artifact.id) : undefined;
    },

    async fetch(artifact, file) {
      if (read === "registry") return registry.fetch(artifact, file);
      const at = within(artifact);
      const bytes = await rootReader(roots.get(artifact.id) ?? at)(file.locator);
      if (bytes === undefined) {
        throw new SpecError(`${file.locator} is missing from the source.`, {
          path: file.locator,
          missing: true,
          artifact: artifact.id,
        });
      }
      return bytes;
    },

    forget() {
      registry.forget();
      listed.clear();
    },
  };
}
