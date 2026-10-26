import { chosenFor, loadedBy, scopeTargets, toolName } from "#cli/render/tools.ts";
import type { RegistryConfig } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { groupArtifacts, summarize } from "#core/console/artifacts.ts";
import type { AccountRow, ConsoleState } from "#core/console/model.ts";
import { LOCAL_GROUP } from "#core/console/model.ts";
import {
  carriedPaths,
  failureReasons,
  jobRows,
  newestFinished,
  runRows,
  upstreamFacts,
} from "#core/console/runs.ts";
import { dict } from "#core/fields.ts";
import type { HostCommandContext } from "#core/host/extend.ts";
import { contributedPanels } from "#core/host/load.ts";
import { emptyLock, type Lock, readLock } from "#core/lock.ts";
import { emptyManifest, type Manifest, readManifest } from "#core/manifest.ts";
import { status } from "#core/plan/status.ts";
import { survey } from "#core/plan/survey.ts";
import { processAlive } from "#core/process.ts";
import { refName } from "#core/ref.ts";
import type { RunCounts, RunRecord } from "#core/run/model.ts";
import { isActive, type RunMode } from "#core/run/model.ts";
import { roots as makeRoots, type Roots, scopeFor } from "#core/store/paths.ts";
import { policyOf } from "#core/sync/policy.ts";
import { earlierTable, resolveTargets } from "#core/target/index.ts";
import { readDaemonPid } from "#daemon/pidfile.ts";
import { readAccounts } from "./accounts.ts";
import { localWork } from "./local.ts";

// One typed answer to "what is on this machine". Opens no socket and takes no
// lease, so it is safe to run while the daemon is mid-sync.

/** Enough history to see the shape of a day without reading the whole run database. */
const RUN_HISTORY = 40;

function alive(pid: number | undefined): boolean {
  return pid !== undefined && processAlive(pid);
}

/** The scope the daemon actually syncs, so the console reads the same tree. */
function rootsFor(config: RegistryConfig, cwd: string): Roots {
  for (const job of config.jobs) {
    for (const step of job.steps) {
      if (step.root !== undefined) return makeRoots(scopeFor(step.root), step.root);
    }
  }
  return makeRoots("user", cwd);
}

/** A publish declares what it published, so this is what marks it as gone. */
function declaredNames(manifest: Manifest): Set<string> {
  const names = new Set<string>();
  for (const ref of manifest.artifacts) {
    const name = refName(ref);
    if (name !== "") names.add(name);
  }
  return names;
}

export interface CollectOptions {
  /** Which account the views are about. Defaults to the first configured one. */
  accountId?: string | undefined;
}

export async function collect(
  context: HostCommandContext,
  options: CollectOptions = {},
): Promise<ConsoleState> {
  const problems: string[] = [];
  const config = await readConfig();
  const roots = rootsFor(config, context.cwd);
  const manifest = await readManifest(roots.manifest).catch(() => undefined);
  if (manifest === undefined) problems.push(`Cannot read ${roots.manifest}.`);
  const resolved: Manifest = manifest ?? emptyManifest();

  const targetTable = resolveTargets();
  const lock = await readLock(roots).catch((error: Error) => {
    problems.push(error.message);
    return emptyLock();
  });
  const surveyed = await survey(lock, roots);
  const statuses = status(lock, surveyed, roots);

  const store = await context.host.openRunStore();
  let runs: RunRecord[] = [];
  try {
    runs = store.list({ limit: RUN_HISTORY });

    const accounts = await readAccounts(config, resolved, {
      byAlias: countByAlias(lock),
    });
    const chosen = pick(accounts, options.accountId);
    const account =
      chosen === undefined
        ? undefined
        : { ...chosen, defaultNamespace: defaultNamespace(config, chosen) };

    // Every view is about the account whose tab is selected, runs included:
    // what another account's sync refused is that account's problem.
    const ours = runs.filter((run) => account === undefined || run.accountId === account.id);
    const jobs = config.jobs.filter((job) => account === undefined || job.account === account.id);
    const syncRun = newestFinished(ours, "sync");
    const syncEvents = syncRun === undefined ? [] : store.notableEvents(syncRun.id);
    const syncJob = jobs.find((job) => job.steps.some((step) => step.root !== undefined));
    // Every other job's newest finished run says which local folders it already carries.
    const carried = carriedPaths(
      jobs
        .filter((job) => job !== syncJob)
        .flatMap((job) => {
          const run = newestFinished(store.list({ jobId: job.id, limit: 5 }));
          return run === undefined
            ? []
            : [
                {
                  job: job.name ?? job.id,
                  jobId: job.id,
                  settledAtMs: run.finishedAtMs,
                  events: store.notableEvents(run.id),
                },
              ];
        }),
    );

    const mine = scopedLock(lock, account?.registry);
    const groups = await groupArtifacts({
      lock: mine,
      survey: surveyed,
      statuses,
      roots,
      upstream: upstreamFacts(syncEvents),
      defaultNamespace: account?.defaultNamespace,
      local: await localWork(roots, targetTable, mine, declaredNames(resolved), carried),
    });

    // Named as they were chosen, by the module every listing uses.
    const scope = scopeTargets(resolved, targetTable);
    for (const row of groups.flatMap((group) => group.rows)) {
      const entry = mine.artifacts[row.key];
      if (entry === undefined) continue;
      row.targets = loadedBy(
        targetTable,
        chosenFor(resolved, scope, entry),
        entry.kind,
        row.targets,
      ).map((name) => toolName(targetTable, name));
    }

    // A panel that throws is reported, not fatal.
    const panels: Record<string, unknown> = {};
    for (const panel of await contributedPanels()) {
      try {
        panels[panel.id] = await panel.collect({
          context,
          config,
          manifest: resolved,
          targetTable,
          harnesses: earlierTable(targetTable),
          account,
          jobs,
          runs: ours,
          store,
        });
      } catch (error) {
        problems.push(`${panel.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const failing = new Set(
      runs.filter((run) => run.errorCode !== undefined || run.state === "failed").map((r) => r.id),
    );
    const pid = await readDaemonPid();

    return {
      version: context.host.version,
      account,
      accounts: accounts.map((row) => (row.id === account?.id ? account : row)),
      groups,
      summary: summarize(groups, syncRun?.counts.examined ?? 0),
      jobs: jobRows({ ...config, jobs }, ours),
      runs: runRows(ours, await failureReasons(failing)),
      daemon: {
        running: alive(pid),
        pid,
        // The daemon runs every job on the machine, whichever registry is on screen.
        jobsEnabled: config.jobs.filter((job) => job.schedule.enabled).length,
        jobsTotal: config.jobs.length,
      },
      policy: syncJob === undefined ? undefined : policyOf(syncJob.steps),
      scope: roots.scope,
      root: roots.base,
      readAtMs: Date.now(),
      problems,
      panels,
    };
  } finally {
    store.close();
  }
}

/** The lockfile narrowed to one registry. */
function scopedLock(lock: Lock, alias: string | undefined): Lock {
  if (alias === undefined) return lock;
  const artifacts: Lock["artifacts"] = dict();
  for (const [key, entry] of Object.entries(lock.artifacts)) {
    if (entry.registry === alias) artifacts[key] = entry;
  }
  return { ...lock, artifacts };
}

function countByAlias(lock: Awaited<ReturnType<typeof readLock>>) {
  const found: Record<string, { artifacts: number; namespaces: number }> = {};
  const spaces: Record<string, Set<string>> = {};
  for (const entry of Object.values(lock.artifacts)) {
    const bucket = found[entry.registry] ?? { artifacts: 0, namespaces: 0 };
    bucket.artifacts += 1;
    found[entry.registry] = bucket;
    const seen = spaces[entry.registry] ?? new Set<string>();
    seen.add(entry.namespace ?? LOCAL_GROUP);
    spaces[entry.registry] = seen;
  }
  for (const [alias, set] of Object.entries(spaces)) {
    const bucket = found[alias];
    if (bucket !== undefined) bucket.namespaces = set.size;
  }
  return found;
}

/**
 * Where an unqualified publish lands. The account holds it once onboarding has
 * chosen one; before that it is only in `defaults.namespace`.
 */
function defaultNamespace(
  config: RegistryConfig,
  account: AccountRow | undefined,
): string | undefined {
  if (account?.defaultNamespace !== undefined) return account.defaultNamespace;
  const declared = config.defaults.namespace;
  if (declared === undefined) return undefined;
  const slash = declared.indexOf("/");
  if (slash === -1) return declared;
  return declared.slice(0, slash) === account?.registry ? declared.slice(slash + 1) : undefined;
}

function pick(accounts: readonly AccountRow[], wanted: string | undefined): AccountRow | undefined {
  if (wanted === undefined) return accounts[0];
  return accounts.find((row) => row.id === wanted || row.registry === wanted) ?? accounts[0];
}

export interface Progress {
  mode: RunMode;
  phase: string | undefined;
  counts: RunCounts;
}

/**
 * What the run started by the last key is doing. The child writes to the same
 * run store, so these counts are the real figure rather than a parsed line.
 */
export async function progress(context: HostCommandContext): Promise<Progress | undefined> {
  const store = await context.host.openRunStore();
  try {
    const live = store.list({ limit: 5 }).find((run) => isActive(run.state));
    if (live === undefined) return undefined;
    return { mode: live.mode, phase: live.step, counts: live.counts };
  } finally {
    store.close();
  }
}
