import { nameCollisionOf } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { readTextIfPresent } from "#core/fs/path.ts";
import type { Lock } from "#core/lock.ts";
import { formatManifest } from "#core/manifest/format.ts";
import { writeManifest } from "#core/manifest/repository.ts";
import { guardsOf } from "#core/plan/apply/link.ts";
import type { ApplyResult } from "#core/plan/apply/run.ts";
import type { Action, Plan } from "#core/plan/model.ts";
import type { Roots, Scope } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import type { Printer } from "#core/term/printer.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, read, withScope } from "#engine/scope/load.ts";
import { commit, prepareWrite, restore, unrecorded } from "./commit.ts";
import { appliedNotices, keptMessage, recoveredNotices, warn } from "./notices.ts";
import { closeAll, plan } from "./plan.ts";
import {
  keptLines,
  refuseBlocked,
  refuseClash,
  refuseCollision,
  refuseLockChange,
  refuseManifestChange,
  refusePlan,
  refuseUnlisted,
  refuseUnstaged,
  refuseUntrusted,
  refuseWithheld,
  trustHint,
  untrustedLine,
} from "./refusals.ts";
import { selectTargets } from "./targets.ts";

export interface RunResult {
  plan: Plan;
  /** What apply did; absent for a dry run, or a plan that was not approved. */
  applied: ApplyResult | undefined;
  /** The lockfile as the run found it, so a report can say what moved. */
  before: Lock;
  /** The targets this run installed for, so a report names them as they were chosen. */
  targets: readonly string[];
  targetTable: Targets;
  scope: Scope;
}

export interface RunHooks {
  /**
   * Asked once the plan is known and before a single byte is written.
   * Returning false leaves the project untouched.
   */
  approve?: ((plan: Plan, targets: readonly string[]) => Promise<boolean>) | undefined;
  /** Re-read every source instead of trusting what the lock pins. */
  refresh?: boolean;
  /** Lock rows this run takes the registry's newest of; every other row installs as locked. */
  moving?: ReadonlySet<string>;
  /** Registries this run changes; the others are left as the lock has them, unopened. */
  aliases?: readonly string[];
  /** Take nothing the lock does not hold, so a removal never installs what was published since. */
  held?: boolean;
  /** Edited rows this run may delete, which `remove` settles before planning. */
  discard?: ReadonlySet<string>;
  /** Artifacts this run names: one left out for another's name is refused, not skipped. */
  adding?: ReadonlySet<string>;
  /** Installed names whose identical copy already on disk this run takes over in place. */
  adopt?: ReadonlySet<string>;
}

/** The targets a run installs for, so a report can name them as they were chosen. */
export interface Chosen {
  targets: readonly string[];
  targetTable: Targets;
}

/** How a run is shown, which the caller decides: the engine only says what happens. */
export interface PlanReport {
  /** The whole plan, for a dry run, and the paths a real run would move to backups. */
  plan(plan: Plan, roots: Roots, aside: ReadonlySet<string>, chosen: Chosen): void;
  /** Each action as apply reaches it. */
  step(action: Action, plan: Plan, chosen: Chosen): void;
}

/** The single install path: `add`, `update` and `remove` differ only in `edit`. */
export async function run(
  roots: Roots,
  common: CommonOptions,
  printer: Printer,
  cwd: string,
  report: PlanReport,
  edit: (loaded: Loaded) => RunHooks | Promise<RunHooks> = () => ({}),
): Promise<RunResult> {
  const body = async (loaded: Loaded) =>
    write(loaded, common, printer, cwd, report, await edit(loaded));
  // A dry run writes nothing to the scope, so it takes no lease and leaves no lease folder behind.
  if (common.dryRun) return body(await read(roots));
  return withScope(roots, body, printer);
}

async function write(
  loaded: Loaded,
  common: CommonOptions,
  printer: Printer,
  cwd: string,
  report: PlanReport,
  hooks: RunHooks,
): Promise<RunResult> {
  const { roots, manifest, lock, targetTable } = loaded;

  warn(printer, recoveredNotices(roots, await prepareWrite(loaded, common.dryRun)));

  const targets = selectTargets(manifest, targetTable, common);
  // Reports name every tool picked, including those an entry's own `targets:` adds.
  const named = [
    ...new Set([
      ...targets,
      ...manifest.artifacts
        .flatMap((ref) => ref.targets ?? [])
        .filter((name) => name in targetTable),
    ]),
  ];
  const collision = nameCollisionOf(await readConfig());
  const { planned, acquired } = await plan(loaded, common, printer, cwd, hooks, targets, collision);
  try {
    if (collision === "fail") refuseCollision(planned);
    refuseClash(planned, hooks.adding);
    for (const warning of planned.warnings) {
      printer.warning(warning.message);
      if (warning.hint !== undefined) printer.hint(warning.hint);
    }
    refusePlan(planned, acquired, lock);
    if (common.frozen) {
      refuseLockChange(lock, planned);
      refuseManifestChange(loaded);
    }

    if (common.dryRun) {
      const guards = await guardsOf(planned, roots);
      const aside = new Set(
        [...guards].flatMap(([path, guard]) => (guard === "backup" ? [path] : [])),
      );
      // Said before the run, so an agent can move a person's folder out of the way first.
      for (const action of planned.actions) {
        if (action.kind === "link" && guards.get(action.to) === "keep")
          printer.warning(keptMessage(roots, action.name, action.to, "Would not"));
      }
      report.plan(planned, roots, aside, { targets: named, targetTable });
      for (const line of keptLines(planned.withheld)) printer.warning(`${line}.`);
      refuseUnlisted(planned.unlisted, printer, undefined);
      if (planned.untrusted.length > 0) {
        printer.warning(`Would not install ${untrustedLine(planned.untrusted)} that run as you.`);
        printer.hint(trustHint(planned.untrusted));
      }
      return {
        plan: planned,
        applied: undefined,
        before: lock,
        targets: named,
        targetTable,
        scope: roots.scope,
      };
    }

    await refuseBlocked(planned);

    if (hooks.approve !== undefined && !(await hooks.approve(planned, named))) {
      return {
        plan: planned,
        applied: undefined,
        before: lock,
        targets: named,
        targetTable,
        scope: roots.scope,
      };
    }

    const edited = formatManifest(manifest) !== loaded.manifestAsRead;
    // Read under the restore's lease, so only this run's edit is undone.
    const before = edited ? await readTextIfPresent(roots.manifest) : undefined;
    const written = edited ? await writeManifest(roots, manifest) : undefined;
    const applied = await commit(
      loaded,
      planned,
      acquired,
      targets,
      (action) => report.step(action, planned, { targets: named, targetTable }),
      async () => {
        // Nothing was recorded, so the manifest must not ask for it.
        if (edited && (await unrecorded(roots, lock)))
          await restore(roots.manifest, before, written);
      },
    );

    warn(printer, appliedNotices(roots, applied, targetTable));

    const landed = applied.installed.length > 0;
    // An edit none of whose artifacts landed, whether unstaged or left out for want of trust,
    // must not leave the manifest asking for them.
    if (edited && !landed && (applied.unstaged.length > 0 || planned.untrusted.length > 0))
      await restore(roots.manifest, before, written);
    refuseUnstaged(applied.unstaged, landed, printer);
    refuseWithheld(planned, printer, hooks.moving);
    refuseUnlisted(planned.unlisted, printer, hooks.moving);
    refuseUntrusted(planned.untrusted);
    return {
      plan: planned,
      applied,
      before: lock,
      targets: named,
      targetTable,
      scope: roots.scope,
    };
  } finally {
    await closeAll(acquired);
  }
}
