import type { Job, RegistryConfig } from "#core/config/model.ts";
import type { Command } from "#core/console/actions.ts";
import type { AccountRow, ArtifactRow, ConsoleState } from "#core/console/model.ts";
import type { Manifest } from "#core/manifest/model.ts";
import type { RunRecord } from "#core/run/model.ts";
import type { RunStore } from "#core/run/store.ts";
import type { EarlierTarget, Targets } from "#core/target/contract.ts";
import type { COLOR, GLYPH } from "#core/term/theme.ts";
import type { HostCommandContext } from "./extend.ts";

/** Opaque on purpose: only the toolkit can make one. */
export type PanelNode = unknown;

export interface PanelBoxProps {
  key?: string;
  flexDirection?: "row" | "column";
  flexGrow?: number;
  width?: number | string;
  justifyContent?: "flex-start" | "flex-end" | "space-between" | "center";
  marginTop?: number;
  marginBottom?: number;
  backgroundColor?: string;
}

export interface PanelTextProps {
  key?: string;
  color?: string;
  bold?: boolean;
  underline?: boolean;
  inverse?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-end";
}

export interface HintKey {
  key: string;
  label: string;
}

/** `above` and `below` let a list say what it cut rather than just cutting. */
export interface ListWindow {
  from: number;
  to: number;
  above: number;
  below: number;
}

/** Handed in, not imported: a second copy of the renderer would reconcile against another tree. */
export interface PanelToolkit {
  box(props: PanelBoxProps | null, ...children: PanelNode[]): PanelNode;
  text(props: PanelTextProps | null, ...children: PanelNode[]): PanelNode;
  plain(value: PanelNode): PanelNode;
  dim(value: PanelNode): PanelNode;
  faint(value: PanelNode): PanelNode;
  rule(width: number): PanelNode;
  heading(label: string): PanelNode;
  /** `[k] label`, the shape every action in the console is announced in. */
  action(key: string, label: string, active?: boolean): PanelNode;
  summaryStrip(props: {
    width: number;
    title: PanelNode;
    badge: { label: string; color: string } | undefined;
    lines: PanelNode[];
    hint: string | undefined;
  }): PanelNode;
  color: typeof COLOR;
  glyph: typeof GLYPH;
  format: {
    ago(atMs: number | undefined, nowMs: number): string;
    bar(done: number, total: number, width: number): string;
    bytes(count: number): string;
    clock(atMs: number | undefined): string;
    day(atMs: number, nowMs: number): string;
    interval(seconds: number): string;
    pad(value: string, width: number): string;
    truncate(value: string, width: number): string;
    truncateStart(value: string, width: number): string;
  };
  window(total: number, cursor: number, height: number): ListWindow;
}

export interface LinkFacts {
  location: string;
  /** The registry's adapter config, which only its adapter reads. */
  config: Readonly<Record<string, string>>;
  /** Who is viewing, where the adapter resolved one. */
  viewer: string | undefined;
}

interface PanelCollectInput {
  context: HostCommandContext;
  config: RegistryConfig;
  manifest: Manifest;
  targetTable: Targets;
  /** @deprecated `targetTable` keyed by aireg 0.1 ids, for adapters built against it. */
  harnesses: Readonly<Record<string, EarlierTarget>>;
  /** The selected tab's account; every view is scoped to it. */
  account: AccountRow | undefined;
  /** Already narrowed to that account. */
  jobs: readonly Job[];
  runs: readonly RunRecord[];
  store: RunStore;
}

export interface PanelView<S = unknown> {
  width: number;
  /** Rows left for the list after the chrome. */
  height: number;
  cursor: number;
  nowMs: number;
  state: ConsoleState;
  /** A panel whose `collect` threw is not called. */
  data: S;
  /** Held by the host so a reload does not lose them. */
  flags: Readonly<Record<string, boolean>>;
  facts: LinkFacts;
  ui: PanelToolkit;
}

/** Every write a panel makes is a child `aireg` command. */
interface PanelKeyContext<S = unknown> {
  view: PanelView<S>;
  setFlag(name: string, value: boolean): void;
  /** Spawns at once; a panel decides whether a bare keypress needs a confirmation first. */
  run(label: string, command: Command): void;
  open(url: string): void;
  reload(): void;
}

export interface PanelContribution<S = unknown> {
  /** Also the key the host files its cursor and flags under. */
  id: string;
  label: string;
  /** Tab to sit after; unknown or absent puts it before Settings. */
  after?: string;
  collect(input: PanelCollectInput): Promise<S>;
  length(view: PanelView<S>): number;
  render(view: PanelView<S>): PanelNode;
  strip?(view: PanelView<S>): PanelNode;
  overview?(view: PanelView<S>): PanelNode;
  settings?(view: PanelView<S>): PanelNode;
  keys?: readonly HintKey[];
  onKey?(input: string, context: PanelKeyContext<S>): void;
  /** Where `o` goes with this row selected. */
  link?(view: PanelView<S>): string | undefined;
  /** Reads only the visible window; true redraws. */
  prefetch?(view: PanelView<S>): Promise<boolean>;
  /** First rendered row of the list, since Ink reports no geometry. */
  listTop?: number;
}

/** The console knows an artifact has a page; only the adapter that served it has the route. */
export interface UpstreamContribution {
  /** Shown as `open in <app>`. */
  app: string;
  /** Where `o` goes when nothing narrower is selected. */
  registry?(facts: LinkFacts): string | undefined;
  artifact?(facts: LinkFacts, row: ArtifactRow): string | undefined;
  namespace?(facts: LinkFacts, namespace: string): string | undefined;
  /** Resolved once per account, then handed back on every `LinkFacts`. */
  viewer?(account: AccountRow): Promise<string | undefined>;
  /** The console cannot know a registry's own rules about re-sending. */
  caution?(row: ArtifactRow): string | undefined;
}
