import type { LinkMode, Lock } from "#core/lock.ts";
import type { Carried } from "#core/plan/carries.ts";
import type { Action, PluginDocument, Staged } from "#core/plan/model.ts";
import type { Roots } from "#core/store/paths.ts";
import type { LinkGuard } from "./link-guard.ts";

/** The actions apply carries out; `record` only writes the lock. */
type Performed = Record<Exclude<Action["kind"], "record">, number>;

export interface ApplyResult {
  /** What ran: a link kept back for a person's own file, or never made, is not counted. */
  performed: Performed;
  /** Artifacts this run linked into a target. */
  installed: string[];
  /** Artifacts the lock holds now that no target had before this run. */
  added: string[];
  /** Artifacts some target had before this run that none has now. */
  removed: string[];
  lock: Lock | undefined;
  /**
   * Targets that asked for a symlink and got a copy. Worth reporting: an edit
   * to the project's artifact no longer reaches that target.
   */
  degraded: string[];
  /**
   * Artifacts, or members of one, the source would not serve intact. The run
   * installs the rest and keeps each one's previous lock row.
   */
  unstaged: { name: string; reason: string; error: unknown }[];
  /** Links not made: a person's own file or folder is at the destination, or `reason` says why. */
  kept: { name: string; path: string; reason?: string; config?: true }[];
  /** Copies already on disk, byte for byte what this run installs, recorded as aireg's in place. */
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

/** What one run learns as it goes, read back when it writes the lock. */
export interface Run {
  roots: Roots;
  ahead: (source: string, path: string) => Promise<Staged>;
  guards: Map<string, LinkGuard>;
  stamp: string | undefined;
  /** Digests are only known once content is on disk, so the lock is patched from these. */
  digests: Map<string, string>;
  /** Where a stage put the bytes, which is not a fixed path for every adapter. */
  materialized: Map<string, Staged>;
  /** Artifacts whose digest is settled; the first copy made is the one it describes. */
  measured: Set<string>;
  upstream: Map<string, string>;
  modes: Map<string, LinkMode>;
  /** A plugin directory is linked once, for its first artifact; the others share its mode. */
  pathModes: Map<string, LinkMode>;
  /** What each copy-mode link wrote, recorded so a later edit to it is seen. */
  copies: Map<string, string>;
  degraded: Set<string>;
  /** Projections to rebuild once every clone has landed: dir -> content, readers. */
  plugins: Map<
    string,
    { content: string; targets: Set<string>; document?: PluginDocument | undefined }
  >;
  /** Fan-out directories to refresh once their projections are final: dir -> projection. */
  fanned: Map<string, string>;
  /** Plugin directories placed as copies, copied again once every member has landed. */
  copiedPlugins: Map<string, ActionOf<"link">>;
  /** Links not made, by `linkKey`; the lock leaves them out. */
  skipped: Set<string>;
  unstaged: Map<string, { reason: string; error: unknown }>;
  performed: Performed;
  installed: Set<string>;
  kept: ApplyResult["kept"];
  adopted: ApplyResult["adopted"];
  backedUp: ApplyResult["backedUp"];
  recorded: Lock | undefined;
  /** The lock as this run found it. */
  before: Lock | undefined;
  projections: ReadonlySet<string> | undefined;
  unrendered: ApplyResult["unrendered"];
}

export const linkKey = (name: string, path: string): string => `${name} ${path}`;
