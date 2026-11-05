import type { LinkMode, Lock } from "#core/lock.ts";
import type { Carried } from "#core/plan/carries.ts";
import type { Action, PluginDocument, Staged } from "#core/plan/model.ts";
import type { Roots } from "#core/store/paths.ts";
import type { LinkGuard } from "./link-guard.ts";

/** `record` only writes the lock, so it is not counted. */
type Performed = Record<Exclude<Action["kind"], "record">, number>;

export interface ApplyResult {
  /** A link kept back for a person's own file, or never made, is not counted. */
  performed: Performed;
  /** Artifacts this run linked into a target. */
  installed: string[];
  /** Artifacts the lock holds now that no target had before this run. */
  added: string[];
  /** Artifacts some target had before this run that none has now. */
  removed: string[];
  lock: Lock | undefined;
  /** Targets that asked for a symlink and got a copy, so project edits no longer reach them. */
  degraded: string[];
  /** Artifacts or members the source would not serve intact; each keeps its previous lock row. */
  unstaged: { name: string; reason: string; error: unknown }[];
  /** Links not made: a person's own file or folder is at the destination, or `reason` says why. */
  kept: { name: string; path: string; reason?: string; config?: true; key?: string }[];
  /** Copies already on disk that match this run byte for byte, recorded as aireg's in place. */
  adopted: { name: string; path: string }[];
  /** A person's own file or folder that stood where a recorded link was, and where it was moved. */
  backedUp: {
    path: string;
    to: string;
    what: "folder" | "file" | "link";
  }[];
  /** Plugins this run installed or updated that carry something a target starts on its own. */
  carried: { name: string; carries: Carried[] }[];
  /** Rendered placements skipped because the artifact could not fill one. */
  unrendered: { name: string; target: string; reason: string }[];
}

export type ActionOf<K extends Action["kind"]> = Extract<Action, { kind: K }>;

type Kept = ApplyResult["kept"][number];
type Adopted = ApplyResult["adopted"][number];
export type BackedUp = ApplyResult["backedUp"][number];
export type Unrendered = ApplyResult["unrendered"][number];
type Unstaged = { reason: string; error: unknown };

export interface PluginSource {
  content: string;
  targets: ReadonlySet<string>;
  document?: PluginDocument | undefined;
}

export interface RunInputs {
  roots: Roots;
  env: NodeJS.ProcessEnv;
  ahead: (source: string, path: string) => Promise<Staged>;
  /** The lock as this run found it. */
  before: Lock | undefined;
  /** One stamp for every backup this run makes, taken at the first. */
  stamp: () => string;
}

export interface RunResults {
  /** Taken before the run; moving a person's file aside settles its path to `replace`. */
  guards: Map<string, LinkGuard>;
  /** Where a stage put the bytes, which is not a fixed path for every adapter. */
  staged: Map<string, Staged>;
  /** Known only once content is on disk; describes the first copy made. */
  digests: Map<string, string>;
  /** By `linkKey`. */
  modes: Map<string, LinkMode>;
  /** A plugin directory is linked once, for its first artifact; the others share its mode. */
  pathModes: Map<string, LinkMode>;
  /** What each copy-mode link wrote, recorded so a later edit to it is seen. */
  copies: Map<string, string>;
  degraded: Set<string>;
  /** Projections to rebuild once every clone has landed, by directory. */
  plugins: Map<string, PluginSource>;
  /** Fan-out directories to refresh once their projections are final: dir -> projection. */
  fanned: Map<string, string>;
  /** Plugin directories placed as copies, copied again once every member has landed. */
  copiedPlugins: Map<string, ActionOf<"link">>;
  /** Links not made, by `linkKey`; the lock leaves them out. */
  skipped: Set<string>;
  unstaged: Map<string, Unstaged>;
  performed: Performed;
  installed: Set<string>;
  kept: Kept[];
  adopted: Adopted[];
  backedUp: BackedUp[];
  unrendered: Unrendered[];
  recorded: Lock | undefined;
  projections: ReadonlySet<string> | undefined;
}

export interface Run {
  readonly inputs: RunInputs;
  readonly results: RunResults;
}

/** NUL is in no name or path, so a key of several parts never reads as another. */
const keyOf = (...parts: readonly string[]): string => parts.join("\u0000");

export const linkKey = (name: string, path: string): string => keyOf(name, path);

export const stageKey = (source: string, path: string): string => keyOf(source, path);

export function startRun(inputs: RunInputs, guards: Map<string, LinkGuard>): Run {
  return {
    inputs,
    results: {
      guards,
      staged: new Map(),
      digests: new Map(),
      modes: new Map(),
      pathModes: new Map(),
      copies: new Map(),
      degraded: new Set(),
      plugins: new Map(),
      fanned: new Map(),
      copiedPlugins: new Map(),
      skipped: new Set(),
      unstaged: new Map(),
      performed: { stage: 0, clone: 0, link: 0, unlink: 0 },
      installed: new Set(),
      kept: [],
      adopted: [],
      backedUp: [],
      unrendered: [],
      recorded: undefined,
      projections: undefined,
    },
  };
}

export interface Staging {
  staged: Staged | undefined;
  unstaged: [string, Unstaged][];
}

export function addStaging(results: RunResults, name: string, staging: Staging): void {
  for (const [key, why] of staging.unstaged) results.unstaged.set(key, why);
  if (staging.staged === undefined) return;
  results.staged.set(name, staging.staged);
  results.performed.stage += 1;
}

/** A clone of nothing staged is not made; `digest` is set only for an artifact's first copy. */
export type Cloned = { cloned: false } | { cloned: true; digest: string | undefined };

export function addCloned(results: RunResults, action: ActionOf<"clone">, cloned: Cloned): void {
  if (!cloned.cloned) {
    results.skipped.add(linkKey(action.name, action.to));
    return;
  }
  if (cloned.digest !== undefined) results.digests.set(action.name, cloned.digest);
  results.performed.clone += 1;
}

/** Without `made`, the link was not made and the lock leaves it out. */
export interface Linked {
  made?: {
    mode: LinkMode;
    digest?: string;
    fanned?: true;
    copiedPlugin?: true;
    /** Asked for a link and got a copy. */
    degraded?: true;
  };
  plugin?: PluginSource;
  backedUp?: BackedUp;
  kept?: Kept;
  adopted?: Adopted;
  unrendered?: Unrendered;
}

export function addLinked(results: RunResults, action: ActionOf<"link">, linked: Linked): void {
  const key = linkKey(action.name, action.to);
  if (linked.plugin !== undefined) results.plugins.set(action.from, linked.plugin);
  if (linked.backedUp !== undefined) {
    results.backedUp.push(linked.backedUp);
    results.guards.set(action.to, "replace");
  }
  if (linked.kept !== undefined) results.kept.push(linked.kept);
  if (linked.unrendered !== undefined) results.unrendered.push(linked.unrendered);
  const { made } = linked;
  if (made === undefined) {
    results.skipped.add(key);
    return;
  }
  if (made.fanned === true) results.fanned.set(action.to, action.from);
  if (made.copiedPlugin === true) results.copiedPlugins.set(action.to, action);
  results.modes.set(key, made.mode);
  results.pathModes.set(action.to, made.mode);
  if (made.digest !== undefined) results.copies.set(action.to, made.digest);
  if (made.degraded === true) results.degraded.add(action.target);
  if (linked.adopted !== undefined) results.adopted.push(linked.adopted);
  results.performed.link += 1;
  results.installed.add(action.name);
}

export function addUnlinked(results: RunResults, backedUp: BackedUp | undefined): void {
  if (backedUp !== undefined) results.backedUp.push(backedUp);
  results.performed.unlink += 1;
}

export interface Recorded {
  lock: Lock;
  projections: ReadonlySet<string>;
  /** Artifacts a plugin folder this run linked installs. */
  installed: string[];
  copies: ReadonlyMap<string, string>;
  plugins: ReadonlyMap<string, PluginSource>;
}

export function addRecorded(results: RunResults, recorded: Recorded): void {
  for (const [to, digest] of recorded.copies) results.copies.set(to, digest);
  for (const [dir, plugin] of recorded.plugins) results.plugins.set(dir, plugin);
  for (const name of recorded.installed) results.installed.add(name);
  results.projections = recorded.projections;
  results.recorded = recorded.lock;
}
