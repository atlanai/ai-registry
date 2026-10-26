import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Survey } from "#core/plan/model.ts";
import type { ArtifactStatus } from "#core/plan/status.ts";
import { artifactPath, copyLeaf, type Roots } from "#core/store/paths.ts";
import {
  type ArtifactGroup,
  type ArtifactRow,
  type ArtifactState,
  emptyCounts,
  LOCAL_GROUP,
  type LocalSummary,
} from "./model.ts";

export interface UpstreamFacts {
  /** Artifacts the last run could not serve, by lock key, with the reason. */
  failed: ReadonlyMap<string, string>;
  /** Published here and not yet approved upstream, by lock key. */
  pending: ReadonlySet<string>;
}

async function changedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function stateOf(
  key: string,
  status: ArtifactStatus | undefined,
  upstream: UpstreamFacts,
): ArtifactState {
  // What the registry says outranks what the disk says: a failed fetch and a
  // pending review both explain the local state rather than competing with it.
  if (upstream.failed.has(key)) return "failed";
  if (upstream.pending.has(key)) return "pending";
  return status?.state ?? "ok";
}

async function row(
  key: string,
  entry: LockArtifact,
  roots: Roots,
  survey: Survey,
  status: ArtifactStatus | undefined,
  upstream: UpstreamFacts,
): Promise<ArtifactRow> {
  const observed = survey.artifacts[key];
  const copy = artifactPath(
    roots,
    entry.registry,
    entry.namespace,
    entry.kind,
    copyLeaf(key, entry.name),
    entry.path,
  );
  return {
    key,
    name: entry.name,
    kind: entry.kind,
    registry: entry.registry,
    namespace: entry.namespace ?? entry.registry,
    id: entry.id ?? "",
    version: entry.version,
    lockDigest: entry.digest,
    diskDigest: observed?.digest,
    state: stateOf(key, status, upstream),
    detail: upstream.failed.get(key) ?? status?.detail,
    targets: [...new Set(entry.links.map((link) => link.target))].sort(),
    copy,
    changedAtMs: await changedAt(copy),
    links: entry.links.map((link) => {
      const seen = observed?.links[link.path];
      const destination = seen?.target === undefined ? undefined : resolve(seen.target);
      return {
        target: link.target,
        path: link.path,
        present: seen?.present === true,
        ok:
          seen?.present === true &&
          (link.mode === "copy" || seen.isLink) &&
          destination !== undefined,
      };
    }),
  };
}

/**
 * Artifacts the registry listed and then refused. They are in no lock and on
 * no disk, so nothing else in the read path would mention them at all.
 */
function refused(lock: Lock, upstream: UpstreamFacts): ArtifactRow[] {
  const rows: ArtifactRow[] = [];
  for (const [key, detail] of upstream.failed) {
    if (lock.artifacts[key] !== undefined) continue;
    const slash = key.lastIndexOf("/");
    rows.push({
      key,
      name: slash === -1 ? key : key.slice(slash + 1),
      kind: "skill",
      registry: "",
      namespace: slash === -1 ? undefined : key.slice(0, slash),
      id: "",
      version: undefined,
      lockDigest: "",
      diskDigest: undefined,
      state: "failed",
      detail,
      targets: [],
      copy: "",
      changedAtMs: undefined,
      links: [],
    });
  }
  return rows;
}

/** Commonest first, so `0.1.0 x349` leads and the outliers follow it. */
function versionSpread(rows: readonly ArtifactRow[]): string[] {
  const tally = new Map<string, number>();
  for (const item of rows) {
    const version = item.version ?? "-";
    tally.set(version, (tally.get(version) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([version, count]) => (count === 1 ? version : `${version} x${count}`));
}

export interface GroupInput {
  lock: Lock;
  survey: Survey;
  statuses: readonly ArtifactStatus[];
  roots: Roots;
  upstream: UpstreamFacts;
  /** The namespace an unqualified publish lands in, marked in the tree. */
  defaultNamespace: string | undefined;
  /** Skills written on this machine that no registry knows about. */
  local: readonly ArtifactRow[];
}

/**
 * The lock, the disk and what the registry refused, folded into one row per
 * artifact and one group per namespace.
 */
export async function groupArtifacts(input: GroupInput): Promise<ArtifactGroup[]> {
  const byKey = new Map(input.statuses.map((item) => [item.name, item]));
  const rows = await Promise.all(
    Object.entries(input.lock.artifacts).map(([key, entry]) =>
      row(key, entry, input.roots, input.survey, byKey.get(key), input.upstream),
    ),
  );

  const all = [...rows, ...refused(input.lock, input.upstream), ...input.local];
  const groups = new Map<string, ArtifactRow[]>();
  for (const item of all) {
    const key = item.namespace ?? LOCAL_GROUP;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }

  return [...groups.entries()]
    .map(([key, members]) => {
      const counts = emptyCounts();
      for (const item of members) counts[item.state] += 1;
      const local = key === LOCAL_GROUP;
      return {
        key,
        label: local ? "THIS MACHINE" : key,
        isDefault: !local && key === input.defaultNamespace,
        authoredHere: local,
        // Trouble first: the rows you can act on should not be scrolled to.
        rows: members.sort(
          (left, right) =>
            RANK[left.state] - RANK[right.state] || left.name.localeCompare(right.name),
        ),
        counts,
        versions: versionSpread(members),
      };
    })
    .sort((left, right) => {
      // This machine sits at the bottom: it is the only group you author into.
      if (left.authoredHere !== right.authoredHere) return left.authoredHere ? 1 : -1;
      return right.rows.length - left.rows.length || left.label.localeCompare(right.label);
    });
}

const RANK: Record<ArtifactState, number> = {
  failed: 0,
  edited: 1,
  dangling: 2,
  missing: 3,
  pending: 4,
  imported: 5,
  unpublished: 6,
  duplicate: 7,
  ok: 8,
};

const NOT_PULLED = new Set<ArtifactState>(["failed", "imported", "unpublished", "duplicate"]);

export function summarize(groups: readonly ArtifactGroup[], examined: number): LocalSummary {
  const total = emptyCounts();
  let imported = 0;
  for (const group of groups) {
    for (const state of Object.keys(total) as ArtifactState[]) {
      total[state] += group.counts[state];
    }
    // Neither a refused artifact nor local work was imported from anywhere.
    imported += group.rows.filter((item) => !NOT_PULLED.has(item.state)).length;
  }
  return {
    skillsImported: imported,
    skillsExamined: Math.max(examined, imported),
    failed: total.failed,
    edited: total.edited,
    dangling: total.dangling,
    missing: total.missing,
    pending: total.pending,
    imported: total.imported,
    unpublished: total.unpublished,
    duplicate: total.duplicate,
  };
}

/** What a namespace row reports: how many rows are where they belong, and what is not. */
export function health(group: ArtifactGroup): { settled: number; trouble: string[] } {
  // Local work a job already carries is where it belongs, like an artifact that matches its lock.
  const settled = group.counts.ok + group.counts.imported;
  const trouble = Object.entries(group.counts)
    .filter(([key, count]) => count > 0 && key !== "ok" && key !== "imported")
    .map(([key, count]) => `${count} ${key}`);
  return { settled, trouble };
}

/** The publishable members of a group: your edits, and anything never sent. */
export function publishable(group: ArtifactGroup): ArtifactRow[] {
  // A folder a job carries goes back through that job, not a publish.
  return group.rows.filter(
    (item) =>
      item.carriedBy === undefined && (item.state === "edited" || item.state === "unpublished"),
  );
}

/** What `publish` takes for a row: an installed name, or the path of work authored here. */
export function selector(row: ArtifactRow): string {
  if (row.state === "unpublished" || row.state === "imported") return row.copy;
  return row.key.includes("/") ? basename(row.key) : row.key;
}
