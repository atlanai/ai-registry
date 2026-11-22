import type { ArtifactRow } from "./model.ts";

/** The name given to work authored here, which no registry lists. */
export const THIS_MACHINE = "this machine";

/** States that need a person, most urgent first; a merged row shows the first it holds. */
const ATTENTION = ["failed", "missing", "dangling", "edited", "duplicate"];

export interface CatalogEntry {
  name: string;
  kind: string;
  namespace?: string;
  version?: string;
  description?: string;
}

export interface Listing {
  name: string;
  entries: readonly CatalogEntry[];
}

export interface Installed {
  row: ArtifactRow;
  local: boolean;
}

/** Something a registry lists, or something installed that none lists, with how it is here. */
export interface Joined {
  /** `<registry>/<namespace>/<kind>/<name>` for a listed artifact, unique for the rest. */
  key: string;
  name: string;
  namespace: string;
  registry: string;
  kind: string;
  /** What the registry serves now; for unlisted work, what is installed. */
  version: string;
  description: string;
  /** True when a registry lists it, so `aireg show` can read it before it is installed. */
  listed: boolean;
  /** The row it is installed as, or the plugin row that carries it. */
  installed: ArtifactRow | undefined;
  /** The console's state, or `available` when nothing on this machine installed it. */
  state: string;
  detail: string;
  /** The lockfile key `aireg remove` takes; undefined for work authored here or carried by a plugin. */
  installedKey: string | undefined;
  local: boolean;
  /** The plugin that brought it, for a skill it carries. */
  carriedBy: string | undefined;
  /** Target ids; a merged row holds every one its observations named. */
  targets: string[];
  links: ArtifactRow["links"];
}

type Base = Pick<
  Joined,
  "key" | "name" | "namespace" | "registry" | "kind" | "version" | "description" | "listed"
>;

/**
 * The registry's view first: everything each registry lists, marked with how it is installed
 * here. Then what is installed that no catalog lists, such as work authored on this machine.
 * `home` shortens a path for a key or a sentence.
 */
export function joinCatalogs(
  catalogs: readonly Listing[],
  rows: readonly Installed[],
  home: (path: string) => string,
): Joined[] {
  const used = new Set<Installed>();
  const joined: Joined[] = [];
  for (const catalog of catalogs) {
    for (const entry of catalog.entries) {
      const namespace = entry.namespace ?? "";
      const matches = matchesOf(catalog.name, entry, rows);
      if (matches.installed !== undefined) used.add(matches.installed);
      const base: Base = {
        key: [catalog.name, namespace, entry.kind, entry.name]
          .filter((part) => part !== "")
          .join("/"),
        name: entry.name,
        namespace,
        registry: catalog.name,
        kind: entry.kind,
        version: entry.version ?? "",
        description: entry.description ?? "",
        listed: true,
      };
      const carriedBy = matches.carrier?.row.name;
      joined.push(
        joinedOf(base, matches.installed ?? matches.carrier, noteOf(matches, home), carriedBy),
      );
    }
  }
  for (const installed of rows) {
    if (!used.has(installed)) joined.push(unlisted(installed, home));
  }
  return reconcileLocal(joined);
}

/** Merges observations of one local folder, keeping every diagnostic and target. */
export function reconcileLocal(artifacts: readonly Joined[]): Joined[] {
  const copies = new Map<string, Joined>();
  const result: Joined[] = [];
  for (const artifact of artifacts) {
    const copy = artifact.local ? (artifact.installed?.copy ?? "") : "";
    const prior = copy === "" ? undefined : copies.get(copy);
    if (prior === undefined) {
      const own = {
        ...artifact,
        targets: [...artifact.targets],
        links: artifact.links.map((link) => ({ ...link })),
      };
      result.push(own);
      if (copy !== "") copies.set(copy, own);
      continue;
    }
    mergeInto(prior, artifact);
  }
  return result;
}

interface Matches {
  installed: Installed | undefined;
  /** A plugin that carries this skill: it installs and leaves with the plugin. */
  carrier: Installed | undefined;
  /** A folder written here with the same name, which says nothing about where it was published. */
  namesake: Installed | undefined;
}

/** What on this machine a catalog entry is: installed from it, or carried by a plugin installed from it. */
function matchesOf(registry: string, entry: CatalogEntry, rows: readonly Installed[]): Matches {
  const namespace = entry.namespace ?? "";
  // A marketplace lists a plugin with no namespace and installs it under its own name.
  const installed = rows.find(
    ({ row, local }) =>
      !local &&
      row.registry === registry &&
      row.name === entry.name &&
      row.kind === entry.kind &&
      ((row.namespace ?? "") === namespace || namespace === ""),
  );
  // A skill a plugin carries is listed under the plugin, and installed with it.
  const carrier =
    installed !== undefined || namespace === ""
      ? undefined
      : rows.find(
          ({ row, local }) =>
            !local && row.registry === registry && row.kind === "plugin" && row.name === namespace,
        );
  const namesake = rows.find(
    ({ row, local }) => local && row.name === entry.name && row.kind === entry.kind,
  );
  return { installed, carrier, namesake };
}

function noteOf(
  { carrier, namesake }: Matches,
  home: (path: string) => string,
): { state: string; detail: string } | undefined {
  if (carrier !== undefined) {
    return {
      state: carrier.row.state,
      detail: `Installed with the plugin ${carrier.row.name}, and removed with it.`,
    };
  }
  if (namesake !== undefined && namesake.row.copy !== "") {
    return {
      state: "available",
      detail: `A folder with this name was written on this machine, at ${home(namesake.row.copy)}.`,
    };
  }
  return undefined;
}

function unlisted(installed: Installed, home: (path: string) => string): Joined {
  const { row, local } = installed;
  const registry = local ? THIS_MACHINE : row.registry;
  return joinedOf(
    {
      // Keys hold no state, so a row keeps its key while the page acts on it.
      key: local
        ? `${THIS_MACHINE}/${row.name}/${row.copy === "" ? row.state : home(row.copy)}`
        : `${registry}/${row.key}`,
      name: row.name,
      namespace: local ? "" : (row.namespace ?? ""),
      registry,
      kind: row.kind,
      version: row.version ?? "",
      description: "",
      listed: false,
    },
    installed,
  );
}

function joinedOf(
  base: Base,
  installed: Installed | undefined,
  note?: { state: string; detail: string },
  carriedBy?: string,
): Joined {
  const row = installed?.row;
  return {
    ...base,
    installed: row,
    state: note?.state ?? row?.state ?? "available",
    detail: note?.detail ?? row?.detail ?? "",
    // A carried skill has no lockfile row of its own: removing it means removing the plugin.
    installedKey:
      installed === undefined || installed.local || carriedBy !== undefined ? undefined : row?.key,
    local: installed?.local === true,
    carriedBy,
    targets: [...new Set(row?.targets ?? [])],
    links: (row?.links ?? []).map((link) => ({ ...link })),
  };
}

function mergeInto(prior: Joined, artifact: Joined): void {
  const states = [...new Set([prior.state, artifact.state])].sort();
  const reported = states.length > 1 ? [`Reported states: ${states.join(", ")}.`] : [];
  prior.detail = [...new Set([prior.detail, artifact.detail, ...reported])]
    .filter(Boolean)
    .join("\n");
  prior.state = ATTENTION.find((state) => states.includes(state)) ?? states[0] ?? prior.state;
  prior.targets = [...new Set([...prior.targets, ...artifact.targets])];
  for (const link of artifact.links) {
    const existing = prior.links.find(
      (item) => item.target === link.target && item.path === link.path,
    );
    if (existing === undefined) prior.links.push({ ...link });
    else {
      existing.ok &&= link.ok;
      existing.present &&= link.present;
    }
  }
  prior.description ||= artifact.description;
}
