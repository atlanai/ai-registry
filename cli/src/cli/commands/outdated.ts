import { credentialFor } from "#accounts/credentials.ts";
import { contentDigest, type ResolveOptions, type Want } from "#adapter/index.ts";
import { shownNames } from "#cli/names.ts";
import { noArguments, parse } from "#cli/options.ts";
import { type Watched, watchedFrom } from "#cli/render/installed.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { connectSource, resolveArtifacts } from "#core/adapter/source.ts";
import type { Entry } from "#core/catalog/model.ts";
import { ExitCode } from "#core/errors.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { type Manifest, pinOf } from "#core/manifest.ts";
import { abbreviate, type Printer, sentence } from "#core/output.ts";
import { type Request, recordedAdapter, wanted } from "#core/plan/acquire.ts";
import { listedAt } from "#core/plan/model.ts";
import { excluded } from "#core/plan/select.ts";
import type { Ref } from "#core/ref.ts";
import { olderThan } from "#core/semver.ts";
import { scopeName } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { load } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

interface Row {
  name: string;
  registry: string;
  current: string;
  latest: string;
  moved: boolean;
  /** The version the manifest pinned, when it pinned one. */
  pinned: string | undefined;
  /** Set when the answer is unknown, rather than known to be unchanged. */
  unchecked: string | undefined;
  /** Published since the last install, under a registry or namespace the manifest takes whole. */
  added?: boolean;
  /** Published from a watched folder, so `aireg update` never moves it; its next publish does. */
  watched?: Watched | undefined;
  unpublished?: true;
}

/** What one source publishes right now, or why it could not be asked. */
interface Head {
  /**
   * Keyed by the address: an artifact's id carries its version, so it never
   * matches across the very bump this command exists to report.
   */
  byAddress: Map<string, Upstream>;
  entries: readonly Entry[];
  why: string | undefined;
}

interface Upstream {
  contentId: string | undefined;
  version: string | undefined;
  name: string;
  namespace: string | undefined;
}

/**
 * Include locked names the manifest does not ask for, so a withdrawal stays
 * visible. Pins are dropped: asking at the pinned version would only echo it back.
 */
function asked(request: Request | undefined, lock: Lock, alias: string): [Want[], ResolveOptions] {
  if (request === undefined || request.all || request.want.length === 0) return [[], {}];
  const locked = Object.values(lock.artifacts)
    .filter((artifact) => artifact.registry === alias)
    .map((artifact) => artifact.name);
  const names = new Set([...request.want.map((item) => item.name), ...locked]);
  return [[...names].map((name) => ({ name })), {}];
}

/** The namespaces a manifest takes whole from one registry; `*` for all of it. */
/** The manifest's whole-registry and whole-namespace entries for one registry. */
function wholes(manifest: Manifest, alias: string): Ref[] {
  return manifest.artifacts.filter((ref) => ref.registry === alias && ref.name === undefined);
}

async function head(alias: string, manifest: Manifest, lock: Lock, base: string): Promise<Head> {
  const declared = manifest.registries[alias];
  if (declared === undefined) {
    return { byAddress: new Map(), entries: [], why: "it is no longer declared" };
  }

  const location = expandLocation(declared.location, base);
  try {
    const credential = await credentialFor(alias, declared, location);
    const open = await connectSource(
      { alias, location, adapter: recordedAdapter(declared, lock, alias), config: declared.config },
      credential === undefined ? {} : { credential },
    );
    try {
      const [want, options] = asked(wanted(manifest, alias), lock, alias);
      const listing = await resolveArtifacts(open, want, options);
      return {
        byAddress: new Map(
          listing.listed.map((item) => [
            item.path,
            {
              contentId: contentDigest(item.artifact.envelope),
              version: item.artifact.version ?? item.artifact.envelope.metadata.version,
              name: item.artifact.envelope.metadata.name,
              namespace: item.artifact.envelope.metadata.namespace,
            },
          ]),
        ),
        entries: listing.catalog.entries,
        why: undefined,
      };
    } finally {
      await open.handle.close();
    }
  } catch (error) {
    return { byAddress: new Map(), entries: [], why: (error as Error).message };
  }
}

function row(name: string, entry: LockArtifact, found: Head, pinned: string | undefined): Row {
  const base = { name, registry: entry.registry, pinned, watched: watchedFrom(entry) };
  if (found.why !== undefined) {
    return { ...base, current: "", latest: "", moved: false, unchecked: found.why };
  }

  const address = listedAt(entry, found.entries);
  const upstream = address === undefined ? undefined : found.byAddress.get(address);
  if (upstream === undefined && entry.origin !== undefined && entry.address === undefined) {
    return {
      ...base,
      current: "",
      latest: "",
      moved: false,
      unchecked: undefined,
      unpublished: true,
    };
  }
  if (upstream === undefined) {
    return {
      ...base,
      current: "",
      latest: "",
      moved: false,
      unchecked: "the registry no longer publishes it",
    };
  }

  const latest =
    upstream.version ?? (upstream.contentId === undefined ? "?" : abbreviate(upstream.contentId));
  // A row of yours whose publish the lock has not recorded yet; the next sync records it.
  if (entry.address === undefined) {
    return {
      ...base,
      current: "",
      latest,
      moved: false,
      unchecked: "it is published, but the lockfile has not recorded which version yet",
    };
  }

  // A source that attests content answers without a download; one that does not
  // can only be compared on the version it publishes. A latest that a yank moved
  // below what is installed is older, so it is not offered as an update.
  const moved =
    !olderThan(upstream.version, entry.version) &&
    (upstream.contentId !== undefined && entry.content !== ""
      ? upstream.contentId !== entry.content
      : upstream.version !== entry.version);

  return {
    ...base,
    // Mirrors `latest`: the version when there is one, the content digest otherwise.
    current: entry.version ?? (entry.content === undefined ? "?" : abbreviate(entry.content)),
    latest,
    moved,
    unchecked:
      upstream.contentId === undefined && upstream.version === undefined
        ? "it publishes neither a content digest nor a version"
        : undefined,
  };
}

/** Artifacts a whole registry or namespace now covers that nothing installed yet. */
function additions(manifest: Manifest, lock: Lock, heads: Map<string, Head>): Row[] {
  const rows: Row[] = [];
  for (const [alias, found] of heads) {
    const refs = wholes(manifest, alias);
    if (refs.length === 0 || found.why !== undefined) continue;
    const locked = new Set(
      Object.values(lock.artifacts)
        .filter((entry) => entry.registry === alias)
        .map((entry) => listedAt(entry, found.entries)),
    );
    // A plugin's skills and agents install with it, so only the plugin can be new.
    const plugins = new Set(
      found.entries.filter((item) => item.kind === "plugin").map((item) => item.name),
    );
    for (const [address, upstream] of found.byAddress) {
      if (locked.has(address)) continue;
      const namespace = upstream.namespace;
      const entry = found.entries.find((item) => item.path === address);
      if (entry?.kind !== "plugin" && entry?.group !== undefined && plugins.has(entry.group)) {
        continue;
      }
      // Covered as install reads it: by a whole entry that doesn't leave it out.
      const covered = refs.some(
        (ref) =>
          (ref.namespace === undefined || ref.namespace === namespace) &&
          (entry === undefined || !excluded(ref, entry)),
      );
      if (!covered) continue;
      rows.push({
        name: namespace === undefined ? upstream.name : `${namespace}/${upstream.name}`,
        registry: alias,
        current: "",
        latest:
          upstream.version ??
          (upstream.contentId === undefined ? "?" : abbreviate(upstream.contentId)),
        moved: true,
        pinned: undefined,
        unchecked: undefined,
        added: true,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function next(printer: Printer, moved: readonly Row[], scope: string): void {
  const flag = scope === "user" ? " -g" : "";
  // A pin that is holding is not something to act on, and `update` never moves a watched row.
  if (moved.some((entry) => entry.pinned === undefined && entry.watched === undefined)) {
    printer.note("next", `aireg update${flag}`);
  }
  if (moved.some((entry) => entry.watched !== undefined)) {
    printer.hint(
      `Run \`aireg sync --dry-run${flag}\` to compare; a watched folder waits for \`aireg sync resolve\` before it publishes over it.`,
    );
  }
}

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, builtin("outdated"));
  noArguments(positionals, "outdated");
  const { roots, manifest, lock } = await load(common, context.cwd, "user");

  const heads = new Map<string, Head>();
  for (const alias of new Set(Object.values(lock.artifacts).map((entry) => entry.registry))) {
    heads.set(alias, await head(alias, manifest, lock, roots.base));
  }

  const rows: Row[] = [];
  for (const name of Object.keys(lock.artifacts).sort()) {
    const entry = lock.artifacts[name] as LockArtifact;
    rows.push(
      row(
        name,
        entry,
        heads.get(entry.registry) ?? {
          byAddress: new Map(),
          entries: [],
          why: "its registry could not be read",
        },
        pinOf(manifest, entry),
      ),
    );
  }
  rows.push(...additions(manifest, lock, heads));

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { scope: roots.scope, artifacts: rows } });
  } else if (rows.length === 0) {
    context.printer.info(
      context.printer.style.dim(`Nothing is installed in ${scopeName(roots.scope)}.`),
    );
  } else {
    const { style } = context.printer;
    const shown = shownNames(lock);
    // Not installed yet, so named like the rest: by its own name unless another row has it.
    const leaf = (name: string) => name.split("/").at(-1) ?? name;
    const taken = new Map<string, number>();
    for (const entry of rows) {
      const name = leaf(shown.get(entry.name) ?? entry.name);
      taken.set(name, (taken.get(name) ?? 0) + 1);
    }
    const named = (entry: Row) =>
      shown.get(entry.name) ?? (taken.get(leaf(entry.name)) === 1 ? leaf(entry.name) : entry.name);
    for (const entry of rows) {
      if (entry.unpublished === true) {
        context.printer.info(style.dim(`${named(entry)} is not published yet.`));
      } else if (entry.unchecked !== undefined) {
        context.printer.warning(`Could not check ${named(entry)}: ${sentence(entry.unchecked)}`);
      }
    }
    const moved = rows.filter((entry) => entry.unchecked === undefined && entry.moved);
    if (moved.length === 0) {
      if (rows.every((entry) => entry.unchecked === undefined)) {
        context.printer.success("Everything is up to date.");
      }
    } else {
      context.printer.info(
        style.bold(`${moved.length} with a newer version in ${scopeName(roots.scope)}`),
      );
      table(
        context.printer,
        [
          { header: "artifact", value: (entry: Row) => named(entry) },
          { header: "from", value: (entry: Row) => entry.registry },
          {
            header: "current",
            value: (entry: Row) => {
              const current = entry.added === true ? style.dim("new") : entry.current;
              if (entry.watched !== undefined) return `${current} ${style.cyan("watched")}`;
              return entry.pinned === undefined ? current : `${current} ${style.yellow("pinned")}`;
            },
          },
          { header: "latest", value: (entry: Row) => style.green(entry.latest) },
        ],
        moved,
      );
      context.printer.info();
      next(context.printer, moved, roots.scope);
    }
  }

  if (rows.some((entry) => (entry.moved && entry.pinned === undefined) || entry.unchecked)) {
    context.exit = ExitCode.Changed;
  }
}
