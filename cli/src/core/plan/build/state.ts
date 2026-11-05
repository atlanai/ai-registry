import type { NameCollision } from "#core/config/model.ts";
import type { Lock } from "#core/lock.ts";
import type { Acquired, Action, Clash, Rewritten, Warning } from "#core/plan/model.ts";
import type { PlannedLink } from "#core/plan/projection.ts";
import type { Survey } from "#core/plan/survey.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";

export interface BuildOptions {
  roots: Roots;
  /** Locates the store and target folders; `targetTable` was resolved with it. */
  env: NodeJS.ProcessEnv;
  /** Already resolved from the manifest or detection. */
  targets: readonly string[];
  targetTable: Targets;
  /** Overwrite or remove a copy that was edited after installation. */
  force: boolean;
  /** Rows whose local edits this run may delete: what `remove` was told to take. */
  discard?: ReadonlySet<string>;
  /** Rows whose copy this run published and the source now serves, so its copy replaces them. */
  restate?: ReadonlySet<string>;
  /** Place real copies instead of links, for targets that will not follow them. */
  copy: boolean;
  /** Re-read every source; one that reports no revision is only read again on request. */
  refresh?: boolean;
  /** Running CLI version, for artifact `engines.aireg` checks. */
  cliVersion?: string;
  /** Absent means every registry; one not opened keeps its lock rows and gets no plan. */
  opened?: readonly string[];
  /** What an artifact whose name another holds gets. Absent, it is left out, never renamed. */
  nameCollision?: NameCollision;
  /** Installed names whose copy on disk matches byte for byte, which aireg takes over. */
  adopt?: ReadonlySet<string>;
}

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
  /** Target paths, by the installed name that claimed each; the first writer wins, loudly. */
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
  /** Held back to the end: a plugin directory outlives one artifact and a sibling may need it. */
  unlinks: Extract<Action, { kind: "unlink" }>[];
  /** By installed name, the installed names of what needs it. */
  neededBy: Map<string, string[]>;
  pruned: string[];
  /** By installed name, the registry address of what holds each claimed path. */
  addresses: Map<string, string>;
  clashes: Clash[];
}
