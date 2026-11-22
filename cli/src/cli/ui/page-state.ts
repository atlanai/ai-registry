import { messageOf } from "#adapter/errors.ts";
import { readRegular } from "#adapter/files.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { collect, readShared } from "#cli/console/data/state.ts";
import { underHome } from "#cli/render/home.ts";
import { toolName } from "#cli/render/tools.ts";
import { type Installed, type Joined, joinCatalogs } from "#core/console/join.ts";
import { type ArtifactRow, type ConsoleState, LOCAL_GROUP } from "#core/console/model.ts";
import { frontmatter } from "#core/frontmatter.ts";
import { resolveTargets } from "#core/target/table.ts";
import { SqliteRunStore } from "#daemon/runs/store.ts";
import type { Catalog, Catalogs } from "./catalogs.ts";
import type { UiArtifact } from "./protocol.ts";

const TARGET_TABLE = resolveTargets(process.env);

/** What the page's server keeps beside each row and never sends: where it is on disk. */
export type KeptArtifact = Omit<UiArtifact, "removable"> & {
  copy: string;
  /** The lockfile key `aireg remove` takes; undefined for work authored here or carried by a plugin. */
  installedKey: string | undefined;
  local: boolean;
};

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
  console: Pick<ConsoleState, "version" | "daemon" | "jobs" | "runs" | "scope"> & {
    root: string;
  };
  problems: string[];
  readAtMs: number;
  /** The folder the console's scope belongs to, where every write runs. */
  root: string;
}

/** The console's state for every account, merged: each view reads one registry at a time. */
async function readInstalled(context: CommandContext) {
  const shared = readShared(context);
  const first = await collect(context, { shared });
  const others = first.accounts.filter((account) => account.id !== first.account?.id);
  const more = await Promise.all(
    others.map((account) =>
      collect(context, { accountId: account.id, shared }).catch((error: unknown) =>
        messageOf(error),
      ),
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

/** The core's join, with paths under `~` and targets by the names a person reads. */
export function joined(catalogs: readonly Catalog[], rows: readonly Installed[]): KeptArtifact[] {
  return joinCatalogs(catalogs, rows, underHome)
    .map(artifactOf)
    .sort((a, b) => a.name.localeCompare(b.name) || a.registry.localeCompare(b.registry));
}

function artifactOf({ installed: row, targets, links, ...joined }: Joined): KeptArtifact {
  return {
    ...joined,
    installedVersion: row?.version ?? "",
    digest: row?.lockDigest ?? "",
    diskDigest: row?.diskDigest ?? "",
    path: row === undefined || row.copy === "" ? "" : underHome(row.copy),
    links: links.map((link) => ({
      ...link,
      target: toolName(TARGET_TABLE, link.target),
      path: underHome(link.path),
    })),
    // Work written here reports target ids; everything else, the names a person reads.
    harnesses: [...new Set(targets.map((name) => toolName(TARGET_TABLE, name)))],
    copy: row?.copy ?? "",
  };
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
    const historyProblems = new Set<string>();
    const context = {
      ...this.#context,
      host: {
        ...this.#context.host,
        openRunStore: async () => {
          try {
            return await this.#context.host.openRunStore();
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EPERM" && code !== "EACCES" && code !== "EROFS") throw error;
            historyProblems.add(
              "Run history is unavailable: aireg cannot access its state database. Installed artifacts are still shown. Run aireg ui in a terminal with access to its home folder.",
            );
            return SqliteRunStore.open(":memory:");
          }
        },
      },
    };
    const installed = await readInstalled(context);
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
        scope: first.scope,
        root: underHome(first.root),
      },
      problems: [
        ...historyProblems,
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
