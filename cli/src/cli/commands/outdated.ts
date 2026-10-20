import { satisfies } from "#adapter/semver.ts";
import { shownNames } from "#cli/names.ts";
import { noArguments, parse } from "#cli/options.ts";
import { type Watched, watchedFrom } from "#cli/render/installed.ts";
import { type Head, head, newer } from "#cli/upstream.ts";
import { ExitCode } from "#core/errors.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { type Manifest, pinOf, rangeOf } from "#core/manifest.ts";
import { abbreviate, type Printer, sentence } from "#core/output.ts";
import { listedAt } from "#core/plan/model.ts";
import { excluded } from "#core/plan/select.ts";
import type { Ref } from "#core/ref.ts";
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
  /** The version range the manifest asks for, when it gives one. */
  range?: string | undefined;
  /** The newest version in `range`, which `aireg update` moves to. */
  inRange?: string | undefined;
  /** Newer than installed past anything that holds it: no pin, and inside its range. Not in JSON. */
  behind?: boolean;
  /** Set when the answer is unknown, rather than known to be unchanged. */
  unchecked: string | undefined;
  /** Published since the last install, under a registry or namespace the manifest takes whole. */
  added?: boolean;
  /** Published from a watched folder, so `aireg update` never moves it; its next publish does. */
  watched?: Watched | undefined;
  unpublished?: true;
}

/** The manifest's whole-registry and whole-namespace entries for one registry. */
function wholes(manifest: Manifest, alias: string): Ref[] {
  return manifest.artifacts.filter((ref) => ref.registry === alias && ref.name === undefined);
}

function row(
  name: string,
  entry: LockArtifact,
  found: Head,
  held: { pinned: string | undefined; range: string | undefined },
): Row {
  const base = { name, registry: entry.registry, ...held, watched: watchedFrom(entry) };
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

  const moved = newer(upstream, entry);
  // A range holds back what is outside it, as a pin holds back everything. An adapter that
  // ignored the range answered outside it, which says nothing about what is inside.
  const within =
    held.range === undefined || address === undefined ? undefined : found.inRange.get(address);
  const inRange =
    within?.version !== undefined && satisfies(within.version, held.range as string)
      ? within
      : undefined;
  const behind =
    held.pinned === undefined &&
    (held.range === undefined ? moved : inRange !== undefined && newer(inRange, entry));

  return {
    ...base,
    ...(held.range === undefined ? {} : { inRange: inRange?.version }),
    behind,
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
        behind: true,
        unchecked: undefined,
        added: true,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function next(printer: Printer, moved: readonly Row[], scope: string): void {
  const flag = scope === "user" ? " -g" : "";
  // A pin or range that is holding is not something to act on, and `update` never moves a
  // watched row.
  if (moved.some((entry) => entry.behind === true && entry.watched === undefined)) {
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
    heads.set(alias, await head(alias, manifest, lock, roots.base, true));
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
          inRange: new Map(),
          entries: [],
          why: "its registry could not be read",
        },
        { pinned: pinOf(manifest, entry), range: rangeOf(manifest, entry) },
      ),
    );
  }
  rows.push(...additions(manifest, lock, heads));

  if (context.printer.format === "json") {
    const artifacts = rows.map(({ behind: _, ...entry }) => entry);
    context.printer.json({ ok: true, data: { scope: roots.scope, artifacts } });
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
              if (entry.range !== undefined) return `${current} ${style.yellow(entry.range)}`;
              return entry.pinned === undefined ? current : `${current} ${style.yellow("pinned")}`;
            },
          },
          {
            header: "in range",
            value: (entry: Row) => {
              if (entry.range === undefined) return "";
              const version = entry.inRange ?? entry.current;
              return entry.behind === true ? style.green(version) : version;
            },
            optional: true,
          },
          { header: "latest", value: (entry: Row) => style.green(entry.latest) },
        ],
        moved,
      );
      context.printer.info();
      next(context.printer, moved, roots.scope);
    }
  }

  if (rows.some((entry) => (entry.moved && entry.behind === true) || entry.unchecked)) {
    context.exit = ExitCode.Changed;
  }
}
