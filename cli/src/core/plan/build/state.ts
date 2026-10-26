import type { NameCollision } from "#core/config/model.ts";
import type { Lock } from "#core/lock.ts";
import type { Acquired, Action, Clash, Rewritten, Survey, Warning } from "#core/plan/model.ts";
import type { PlannedLink } from "#core/plan/projection.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Targets } from "#core/target/index.ts";

export interface BuildOptions {
  roots: Roots;
  /** Target names to project into, already resolved from manifest or detection. */
  targets: readonly string[];
  /** Every target, built in or defined by a file of yours. */
  targetTable: Targets;
  /** Overwrite or remove a project copy that was edited after installation. */
  force: boolean;
  /** Rows whose local edits this run may delete: what `remove` was told to take. */
  discard?: ReadonlySet<string>;
  /** Rows whose copy this run published and the source now serves, so its copy replaces them. */
  restate?: ReadonlySet<string>;
  /** Place real copies instead of links, for targets that will not follow them. */
  copy: boolean;
  /**
   * Re-read every source rather than trusting the lock. A source that reports
   * no revision has nothing else to compare, so only an explicit ask looks again.
   */
  refresh?: boolean;
  /** Running CLI version, for artifact `engines.aireg` checks. */
  cliVersion?: string;
  /**
   * Registries this run opened. Absent means every one; any other keeps its
   * lock rows and source as they are, and nothing is planned for it.
   */
  opened?: readonly string[];
  /** What an artifact whose name another holds gets. Absent, it is left out, never renamed. */
  nameCollision?: NameCollision;
  /** Installed names whose copy already on disk, byte for byte what aireg installs, it takes over. */
  adopt?: ReadonlySet<string>;
}

/** What planning one run accumulates, shared by every step that plans part of it. */
export interface BuildState {
  lock: Lock;
  survey: Survey;
  options: BuildOptions;
  byAlias: Map<string, Acquired>;
  actions: Action[];
  unchanged: string[];
  next: Lock;
  warnings: Warning[];
  rewritten: Rewritten[];
  /** Plugin parts can collide in one target path: the first writer wins, loudly. */
  claimed: Map<string, string>;
  /** Plugin directories claimed, by the namespace content each links: its artifacts share it. */
  plugins: Map<string, string>;
  /** By installed name, where each artifact of this run would link before any claim. */
  wants: Map<string, readonly PlannedLink[]>;
  /** Target paths the lockfile records for this run's artifacts, by the one that holds each. */
  recorded: Map<string, string>;
  /** One link action per destination: a plugin is shared by its whole namespace. */
  linked: Set<string>;
  /** Registries read this run whose adapter declares each namespace a plugin. */
  wrapping: ReadonlySet<string>;
  /** Plugin directories two registries' namespaces would share. */
  crowded: ReadonlySet<string>;
  /**
   * Held back until every item is planned. A plugin directory outlives any one
   * artifact, so a rename or a removal must not unlink what a sibling still needs.
   */
  unlinks: Extract<Action, { kind: "unlink" }>[];
  /** By installed name, the installed names of what needs it. */
  neededBy: Map<string, string[]>;
  pruned: string[];
  /** By installed name, the registry address of what holds each claimed path. */
  addresses: Map<string, string>;
  clashes: Clash[];
}
