import { messageOf } from "#adapter/errors.ts";
import { readRegular } from "#adapter/files.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { collect } from "#cli/console/data/state.ts";
import { underHome } from "#cli/render/home.ts";
import { toolName } from "#cli/render/tools.ts";
import { type ArtifactRow, type ConsoleState, LOCAL_GROUP } from "#core/console/model.ts";
import { frontmatter } from "#core/frontmatter.ts";
import { resolveTargets } from "#core/target/table.ts";
import type { Catalog, Catalogs } from "./catalogs.ts";

const TARGET_TABLE = resolveTargets(process.env);

/** The name the page gives work authored here, which no registry lists. */
export const THIS_MACHINE = "this machine";

/** One row of the page's list: something a registry publishes, or something installed here. */
interface PageArtifact {
  /** `<registry>/<namespace>/<kind>/<name>` for a listed artifact, unique for the rest. */
  key: string;
  name: string;
  namespace: string;
  registry: string;
  kind: string;
  /** What the registry serves now; for unlisted work, what is installed. */
  version: string;
  installedVersion: string;
  description: string;
  /** The console's state, or `available` when nothing on this machine installed it. */
  state: string;
  detail: string;
  digest: string;
  diskDigest: string;
  /** Under `~`. */
  path: string;
  links: { target: string; path: string; present: boolean; ok: boolean }[];
  harnesses: string[];
  /** True when a registry lists it, so `aireg show` can read it before it is installed. */
  listed: boolean;
}

/** What the page's server keeps beside each row and never sends: where it is on disk. */
export interface KeptArtifact extends PageArtifact {
  copy: string;
  /** The lockfile key `aireg remove` takes; undefined for work authored here or carried by a plugin. */
  installedKey: string | undefined;
  local: boolean;
  /** The plugin that brought it, for a skill it carries. */
  carriedBy: string | undefined;
}

export interface PageState {
  artifacts: KeptArtifact[];
  registries: {
    name: string;
    address: string;
    count: number;
    installed: number;
    error: string | undefined;
    loading: boolean;
  }[];
  console: Pick<ConsoleState, "version" | "daemon" | "jobs" | "runs" | "policy" | "scope"> & {
    root: string;
    groups: { key: string; rows: ArtifactRow[] }[];
  };
  problems: string[];
  readAtMs: number;
  /** The folder the console's scope belongs to, where every write runs. */
  root: string;
}

interface Installed {
  row: ArtifactRow;
  local: boolean;
}

/** The console's state for every account, merged: each view reads one registry at a time. */
async function readInstalled(context: CommandContext) {
  const first = await collect(context);
  const others = first.accounts.filter((account) => account.id !== first.account?.id);
  const more = await Promise.all(
    others.map((account) =>
      collect(context, { accountId: account.id }).catch((error: unknown) => messageOf(error)),
    ),
  );
  const states = [first, ...more.filter((read): read is ConsoleState => typeof read !== "string")];
  const rows = new Map<string, Installed>();
  const jobs = new Map(first.jobs.map((job) => [job.id, job]));
  const runs = new Map(first.runs.map((run) => [run.id, run]));
  const problems = new Set([...first.problems, ...more.filter((read) => typeof read === "string")]);
  for (const state of states) {
    for (const group of state.groups) {
      const local = group.key === LOCAL_GROUP;
      for (const row of group.rows) {
        // Work authored here shows in every account's view; one row per folder is enough.
        const id = local
          ? `local\u0000${row.copy}\u0000${row.state}`
          : `${row.registry}\u0000${row.key}`;
        if (!rows.has(id)) rows.set(id, { row, local });
      }
    }
    for (const job of state.jobs) jobs.set(job.id, job);
    for (const run of state.runs) runs.set(run.id, run);
    for (const problem of state.problems) problems.add(problem);
  }
  return {
    first,
    rows: [...rows.values()],
    jobs: [...jobs.values()],
    runs: [...runs.values()].sort((a, b) => b.requestedAtMs - a.requestedAtMs),
    problems: [...problems],
  };
}

/** Read without following a link, as every file the page shows is. */
async function ownDescription(row: ArtifactRow): Promise<string> {
  if (row.kind !== "skill" || row.copy === "") return "";
  const read = await readRegular(row.copy, SKILL_ENTRY).catch(() => undefined);
  if (read?.kind !== "file") return "";
  return frontmatter(read.bytes.toString("utf8", 0, 16_384)).description ?? "";
}

function artifactOf(
  base: Pick<
    PageArtifact,
    "key" | "name" | "namespace" | "registry" | "kind" | "version" | "description" | "listed"
  >,
  installed: Installed | undefined,
  state?: { state: string; detail: string },
  carriedBy?: string,
): KeptArtifact {
  const row = installed?.row;
  return {
    ...base,
    installedVersion: row?.version ?? "",
    state: state?.state ?? row?.state ?? "available",
    detail: state?.detail ?? row?.detail ?? "",
    digest: row?.lockDigest ?? "",
    diskDigest: row?.diskDigest ?? "",
    path: row === undefined || row.copy === "" ? "" : underHome(row.copy),
    links: (row?.links ?? []).map((link) => ({
      ...link,
      target: toolName(TARGET_TABLE, link.target),
      path: underHome(link.path),
    })),
    // Work written here reports target ids; everything else, the names a person reads.
    harnesses: [...new Set((row?.targets ?? []).map((name) => toolName(TARGET_TABLE, name)))],
    copy: row?.copy ?? "",
    // A carried skill has no lockfile row of its own: removing it means removing the plugin.
    installedKey:
      installed === undefined || installed.local || carriedBy !== undefined ? undefined : row?.key,
    local: installed?.local === true,
    carriedBy,
  };
}

interface Matches {
  installed: Installed | undefined;
  /** A plugin that carries this skill: it installs and leaves with the plugin. */
  carrier: Installed | undefined;
  /** A folder written here with the same name, which says nothing about where it was published. */
  namesake: Installed | undefined;
}

/** What on this machine a catalog entry is: installed from it, or carried by a plugin installed from it. */
function matchesOf(
  registry: string,
  entry: Catalog["entries"][number],
  rows: readonly Installed[],
): Matches {
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

function noteOf({ carrier, namesake }: Matches): { state: string; detail: string } | undefined {
  if (carrier !== undefined) {
    return {
      state: carrier.row.state,
      detail: `Installed with the plugin ${carrier.row.name}, and removed with it.`,
    };
  }
  if (namesake !== undefined && namesake.row.copy !== "") {
    return {
      state: "available",
      detail: `A folder with this name was written on this machine, at ${underHome(namesake.row.copy)}.`,
    };
  }
  return undefined;
}

/**
 * The registry's view first: everything each registry lists, marked with how it is installed
 * here. Then what is installed that no catalog lists, such as work authored on this machine.
 */
export function joined(catalogs: readonly Catalog[], rows: readonly Installed[]): KeptArtifact[] {
  const used = new Set<Installed>();
  const artifacts: KeptArtifact[] = [];
  for (const catalog of catalogs) {
    for (const entry of catalog.entries) {
      const namespace = entry.namespace ?? "";
      const matches = matchesOf(catalog.name, entry, rows);
      if (matches.installed !== undefined) used.add(matches.installed);
      artifacts.push(
        artifactOf(
          {
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
          },
          matches.installed ?? matches.carrier,
          noteOf(matches),
          matches.carrier?.row.name,
        ),
      );
    }
  }
  for (const installed of rows) {
    if (used.has(installed)) continue;
    const { row, local } = installed;
    const registry = local ? THIS_MACHINE : row.registry;
    artifacts.push(
      artifactOf(
        {
          // Keys hold no state, so a row keeps its key while the page acts on it.
          key: local
            ? `${THIS_MACHINE}/${row.name}/${row.copy === "" ? row.state : underHome(row.copy)}`
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
      ),
    );
  }
  return artifacts.sort(
    (a, b) => a.name.localeCompare(b.name) || a.registry.localeCompare(b.registry),
  );
}

/** Everything the page shows, read once and shared for a few seconds. */
export class PageReader {
  readonly #context: CommandContext;
  readonly #catalogs: Catalogs;
  #last: PageState | undefined;
  #pending: Promise<PageState> | undefined;

  constructor(context: CommandContext, catalogs: Catalogs) {
    this.#context = context;
    this.#catalogs = catalogs;
  }

  read(fresh = false): Promise<PageState> {
    if (!fresh && this.#last !== undefined && Date.now() - this.#last.readAtMs < 3000) {
      return Promise.resolve(this.#last);
    }
    // A fresh read waits out one already running, which may predate the write that asked.
    const after =
      fresh && this.#pending !== undefined ? this.#pending.catch(() => undefined) : undefined;
    if (after === undefined && this.#pending !== undefined) return this.#pending;
    const next = (after ?? Promise.resolve()).then(() => this.#readNow());
    this.#pending = next.finally(() => {
      if (this.#pending === tracked) this.#pending = undefined;
    });
    const tracked = this.#pending;
    return tracked;
  }

  async #readNow(): Promise<PageState> {
    // Catalogs are read in the scope the console shows, so the list and every write agree.
    const installed = await readInstalled(this.#context);
    const { catalogs, problem } = await this.#catalogs.read(installed.first.scope);
    const artifacts = joined(catalogs, installed.rows);
    await Promise.all(
      artifacts
        .filter((artifact) => !artifact.listed && artifact.description === "")
        .map(async (artifact) => {
          const row = installed.rows.find(({ row }) => row.copy === artifact.copy)?.row;
          if (row !== undefined) artifact.description = await ownDescription(row);
        }),
    );
    const first = installed.first;
    const state: PageState = {
      artifacts,
      registries: catalogs.map((catalog) => ({
        name: catalog.name,
        address: catalog.address,
        count: catalog.entries.length,
        installed: artifacts.filter((a) => a.registry === catalog.name && a.state !== "available")
          .length,
        error: catalog.error,
        loading: catalog.loading,
      })),
      console: {
        version: first.version,
        daemon: first.daemon,
        jobs: installed.jobs,
        runs: installed.runs,
        policy: first.policy,
        scope: first.scope,
        root: underHome(first.root),
        groups: [
          { key: LOCAL_GROUP, rows: installed.rows.filter((r) => r.local).map((r) => r.row) },
        ],
      },
      problems: [
        ...(problem === undefined ? [] : [problem]),
        ...catalogs.flatMap((c) =>
          c.error === undefined ? [] : [`${c.name} did not list its artifacts: ${c.error}`],
        ),
        ...installed.problems,
      ],
      readAtMs: Date.now(),
      root: first.root,
    };
    this.#last = state;
    return state;
  }
}
