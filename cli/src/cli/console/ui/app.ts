import { useApp, useInput, useWindowSize } from "ink";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { step, windowAround } from "#cli/console/model/list.ts";
import { collect, type Progress, progress } from "#cli/console/model/state.ts";
import { underHome } from "#cli/render/home.ts";
import * as commands from "#core/console/actions.ts";
import { publishable, selector } from "#core/console/artifacts.ts";
import { flatten, type Line } from "#core/console/flatten.ts";
import type { ArtifactRow, ConsoleState } from "#core/console/model.ts";
import type { HostCommandContext } from "#core/host/extend.ts";
import type {
  LinkFacts,
  PanelContribution,
  PanelNode,
  PanelView,
  UpstreamContribution,
} from "#core/host/panel.ts";
import { POLICY_AXES } from "#core/sync/policy.ts";
import { clock } from "#core/term/format.ts";
import { COLOR } from "#core/term/theme.ts";
import { accountsView } from "./accounts-view.ts";
import { artifactsSummary, artifactsView } from "./artifacts-view.ts";
import {
  accountTabs,
  accountTabWidths,
  footer,
  header,
  type Tab,
  tabsWith,
  viewTabs,
  viewTabWidths,
} from "./chrome.ts";
import { box, faint, plain, text } from "./elements.ts";
import { jobLines, jobsSummaryStrip, jobsView, runWindow } from "./jobs-view.ts";
import { jobsIndexAt, LAYOUT, listTop, type MouseEvent, tabAt, useMouse } from "./mouse.ts";
import {
  activityPanel,
  artifactDetail,
  groupTitle,
  helpPanel,
  type PublishPlan,
  publishConfirm,
  withLine,
} from "./overlays.ts";
import { overviewView } from "./overview-view.ts";
import { settingsView } from "./settings-view.ts";
import { toolkit } from "./toolkit.ts";

// Every write goes through a confirm screen; there is no `--yes` equivalent in here.

/** One line of what a run has got through, from its own counts. */
function describe(live: Progress | undefined): string | undefined {
  if (live === undefined) return undefined;
  const { examined, changed, failed } = live.counts;
  const phase = live.phase === undefined ? "" : `${live.phase} \u00b7 `;
  return (
    `${phase}${examined} checked \u00b7 ${changed} changed` +
    (failed > 0 ? ` \u00b7 ${failed} failed` : "")
  );
}

interface Activity {
  label: string;
  startedAtMs: number;
  command: commands.Command;
  lines: string[];
  done: boolean;
  code: number | undefined;
  /** Undefined until the reload runs; empty means nothing here moved. */
  changed: string[] | undefined;
  cancel: () => void;
}

/** Every artifact's state, to compare the reload afterwards against. */
function snapshot(state: ConsoleState): Map<string, string> {
  return new Map(
    state.groups.flatMap((group) =>
      group.rows.map((row): [string, string] => [`${group.key}/${row.key}`, row.state]),
    ),
  );
}

/**
 * What moved between two reads. A command that exits 0 having changed nothing
 * is the case worth naming: it is what a refused re-publish looks like here.
 */
function difference(before: Map<string, string>, after: ConsoleState): string[] {
  const seen = snapshot(after);
  const name = (key: string) => key.slice(key.indexOf("/") + 1);
  const group = (key: string) => key.slice(0, key.indexOf("/"));
  const gone = [...before.keys()].filter((key) => !seen.has(key));
  const lines: string[] = [];

  for (const [key, state] of seen) {
    const was = before.get(key);
    if (was !== undefined) {
      if (was !== state) lines.push(`${name(key)}: ${was} \u2192 ${state}`);
      continue;
    }
    // Approval moves an artifact from the local group into its namespace, and
    // it keeps its key. Two lines would read as two artifacts.
    const moved = gone.find((old) => name(old) === name(key));
    if (moved !== undefined) {
      gone.splice(gone.indexOf(moved), 1);
      const from = before.get(moved);
      lines.push(`${name(key)}: ${from} in ${group(moved)} \u2192 ${state} in ${group(key)}`);
      continue;
    }
    lines.push(`${name(key)} is now here, ${state}`);
  }
  for (const key of gone) lines.push(`${name(key)} is gone`);
  return lines;
}

type Overlay =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "detail"; row: ArtifactRow }
  | { kind: "publish"; plan: PublishPlan };

/** A tab whose adapter could not answer, or threw while drawing. */
function unreadable(label: string, why: string | undefined): ReactNode {
  return box(
    { flexDirection: "column", marginTop: 1 },
    text({ color: COLOR.orange }, `  ${label} could not be read.`),
    faint(`  ${why ?? "The adapter that provides this tab did not answer."}`),
  );
}

/**
 * A panel is third-party code inside our render tree, and Ink has no error boundary:
 * an exception in one takes the whole console with it.
 */
function attempt(label: string, draw: () => PanelNode): ReactNode {
  try {
    return draw() as ReactNode;
  } catch (error) {
    return unreadable(label, error instanceof Error ? error.message : String(error));
  }
}

function counted(panel: { label: string; length: (view: PanelView) => number }, view: PanelView) {
  try {
    const length = panel.length(view);
    return Number.isInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function useSize(): { width: number; height: number } {
  const { columns, rows } = useWindowSize();
  return {
    width: Math.max(80, columns),
    // Ink writes a newline after each frame; a frame as tall as the terminal
    // scrolls it a row, and the header off the top.
    height: Math.max(20, rows - 1),
  };
}

export interface AppProps {
  context: HostCommandContext;
  initial: ConsoleState;
  /** Tabs contributed by adapters, already loaded so the render stays sync. */
  // biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
  panels: readonly PanelContribution<any>[];
  upstream: UpstreamContribution | undefined;
  /** Resolved once per account by the upstream, for links that scope by viewer. */
  viewer: string | undefined;
}

type Key = Parameters<Parameters<typeof useInput>[0]>[1];

function useSession(props: AppProps) {
  const { exit } = useApp();
  const { width, height } = useSize();
  const [state, setState] = useState<ConsoleState>(props.initial);
  // Commands read the latest state even when a memoized callback starts them.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [accountId, setAccountId] = useState<string | undefined>(props.initial.account?.id);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const [view, setView] = useState<string>("overview");
  const [cursors, setCursors] = useState<Record<string, number>>({});
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  // Each panel's own toggles, by panel id, kept here so a reload keeps them.
  const [flags, setFlags] = useState<Record<string, Record<string, boolean>>>({});
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [activity, setActivity] = useState<Activity | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  // A panel's lazy read is not state the render holds; this is what redraws.
  const [, setPrefetched] = useState(0);
  const [live, setLive] = useState<Progress | undefined>(undefined);

  // While something is running, its own run record is the progress: the child writes
  // to the same store, and the counts there aggregate what it has recorded.
  const running = activity !== undefined && !activity.done;
  useEffect(() => {
    if (!running) {
      setLive(undefined);
      return;
    }
    const timer = setInterval(() => {
      void progress(props.context).then(setLive);
    }, 1_500);
    return () => clearInterval(timer);
  }, [running, props.context]);

  // A clock, so "edited 4m ago" stays true while the console is open.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), running ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [running]);

  const reload = useCallback(
    async (wanted?: string): Promise<ConsoleState> => {
      setBusy(true);
      try {
        // Read through the ref: a command that finishes after an account
        // switch must not reload the account it started under.
        const next = await collect(props.context, { accountId: wanted ?? accountRef.current });
        setState(next);
        return next;
      } finally {
        setBusy(false);
      }
    },
    [props.context],
  );
  return {
    props,
    exit,
    width,
    height,
    state,
    setState,
    stateRef,
    accountId,
    setAccountId,
    accountRef,
    view,
    setView,
    cursors,
    setCursors,
    folded,
    setFolded,
    filter,
    setFilter,
    filtering,
    setFiltering,
    flags,
    setFlags,
    overlay,
    setOverlay,
    activity,
    setActivity,
    busy,
    setBusy,
    nowMs,
    setNowMs,
    setPrefetched,
    live,
    setLive,
    running,
    reload,
  };
}

function useViews(context: ReturnType<typeof useSession>) {
  const {
    props,
    width,
    height,
    state,
    view,
    cursors,
    setCursors,
    folded,
    filter,
    flags,
    nowMs,
    setPrefetched,
  } = context;
  const facts: LinkFacts = useMemo(
    () => ({
      location: state.account?.address ?? "",
      config: state.account?.config ?? {},
      viewer: props.viewer,
    }),
    [state, props.viewer],
  );

  const app = props.upstream?.app ?? "the registry";
  const tabs: Tab[] = useMemo(() => tabsWith(props.panels), [props.panels]);
  const panel = props.panels.find((contribution) => contribution.id === view);

  const artifacts = useMemo(
    () => flatten(state.groups, { folded, filter, only: undefined }),
    [state.groups, folded, filter],
  );
  const jobs = useMemo(() => jobLines(state), [state]);

  // Header, registry tabs, view tabs, the list's own heading, the summary strip
  // and the footer. What is left is how many rows a list may draw.
  const listHeight = Math.max(4, height - 16);

  /** A panel gets the toolkit and its own slice of the state, nothing else. */
  // biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
  const panelViewAt = (at: number): PanelView<any> => ({
    width,
    height: listHeight,
    cursor: at,
    nowMs,
    state,
    data: state.panels[view],
    flags: flags[view] ?? {},
    facts,
    ui: toolkit,
  });

  const lengths: Record<string, number> = {
    // The namespace rows: up and down have to do something on every view, and
    // enter on one is the shortest path to its artifacts.
    overview: state.groups.length,
    artifacts: artifacts.lines.length,
    jobs: jobs.length,
    accounts: state.accounts.length,
    settings: POLICY_AXES.length,
  };

  // The cursor needs a length and a panel's length needs a view, so the panel is
  // measured at zero first; one whose `collect` threw has no state and is not called.
  const collected = panel === undefined ? undefined : state.panels[panel.id];
  const length =
    panel === undefined
      ? (lengths[view] ?? 0)
      : collected === undefined
        ? 0
        : counted(panel, panelViewAt(0));
  const cursor = Math.min(cursors[view] ?? 0, Math.max(0, length - 1));
  const panelView =
    panel === undefined || collected === undefined ? undefined : panelViewAt(cursor);
  const move = (delta: number) =>
    setCursors((current) => ({ ...current, [view]: step(cursor, delta, length) }));

  // Asked every render: the panel knows what it has read, and false is cheap.
  const prefetch = panel?.prefetch;
  useEffect(() => {
    if (prefetch === undefined || panelView === undefined) return;
    void prefetch(panelView).then((changed) => {
      if (changed) setPrefetched((count) => count + 1);
    });
  }, [prefetch, panelView, setPrefetched]);

  const selectedArtifact: Line | undefined = artifacts.lines[cursor];
  const selectedJob = jobs[cursor];
  return {
    ...context,
    facts,
    app,
    tabs,
    panel,
    artifacts,
    jobs,
    listHeight,
    panelViewAt,
    lengths,
    collected,
    length,
    cursor,
    panelView,
    move,
    prefetch,
    selectedArtifact,
    selectedJob,
  };
}

function useCommands(context: ReturnType<typeof useViews>) {
  const { props, state, stateRef, setActivity, reload } = context;
  const run = useCallback(
    (label: string, command: commands.Command) => {
      // Read before the child starts, so the outcome is observed not assumed.
      const before = snapshot(stateRef.current);
      const child = commands.start(command, stateRef.current.root, (line) =>
        setActivity((current) =>
          current === undefined ? current : { ...current, lines: withLine(current.lines, line) },
        ),
      );
      setActivity({
        label,
        startedAtMs: Date.now(),
        command,
        lines: [],
        done: false,
        code: undefined,
        changed: undefined,
        cancel: child.cancel,
      });
      void child.done.then(async (code) => {
        setActivity((current) =>
          current === undefined ? current : { ...current, done: true, code },
        );
        const after = await reload();
        setActivity((current) =>
          current === undefined ? current : { ...current, changed: difference(before, after) },
        );
      });
    },
    [reload, setActivity, stateRef],
  );

  const planForRow = (row: ArtifactRow): PublishPlan | undefined => {
    // A folder a job carries goes back through that job, not a publish.
    if (row.carriedBy !== undefined) return undefined;
    const authored = row.state === "unpublished";
    if (row.state !== "edited" && !authored) return undefined;
    // An artifact that came from a namespace goes back to it on its own; only
    // work authored here has to be told which registry to land in.
    const alias = authored ? state.account?.registry : undefined;
    return {
      title: row.name,
      alias,
      namespace: row.namespace ?? state.account?.defaultNamespace,
      send: [row],
      skip: [],
      wholeGroupOnly: false,
      caution: props.upstream?.caution?.(row),
      command: commands.publish(
        [selector(row)],
        alias === undefined ? undefined : state.account?.defaultNamespace,
        state.scope,
      ).display,
    };
  };

  /** Runs the job that imports an edited folder; false when the row is not one. */
  const importNow = (row: ArtifactRow): boolean => {
    if (row.carriedBy === undefined || row.state !== "edited") return false;
    run(`importing ${row.name}`, commands.runJob(row.carriedBy));
    return true;
  };

  const publishPlan = (line: Line | undefined): PublishPlan | undefined => {
    if (line === undefined) return undefined;
    const alias = state.account?.registry;
    if (line.kind === "artifact") return planForRow(line.row);
    const group = line.group;
    const ready = publishable(group);
    // A pending artifact is already upstream; re-sending it is refused and
    // kills the rest of the batch, so it is named before the key is pressed.
    const skip = group.rows
      .filter((row) => row.state === "pending")
      .map((row) => ({ row, why: "already upstream, waiting for review" }));
    const target = group.authoredHere ? alias : undefined;
    return {
      title: groupTitle(group),
      alias: target,
      namespace: group.authoredHere ? state.account?.defaultNamespace : group.label,
      send: ready,
      skip,
      wholeGroupOnly: group.authoredHere,
      caution: ready.map((row) => props.upstream?.caution?.(row)).find((why) => why !== undefined),
      command: commands.publish(
        ready.map(selector),
        target === undefined ? undefined : state.account?.defaultNamespace,
        state.scope,
      ).display,
    };
  };
  return { ...context, run, planForRow, importNow, publishPlan };
}

function useLinks(context: ReturnType<typeof useCommands>) {
  const { props, view, facts, panel, panelView, selectedArtifact } = context;
  const artifactLink = (row: ArtifactRow): string | undefined =>
    props.upstream?.artifact?.(facts, row);

  /** Where `o` goes. The routes are the adapter's; which row is selected is not. */
  const openSelected = () => {
    let url: string | undefined;
    if (panel !== undefined && panelView !== undefined) {
      try {
        url = panel.link?.(panelView);
      } catch {
        url = undefined;
      }
    } else if (view === "artifacts" && selectedArtifact !== undefined) {
      url =
        selectedArtifact.kind === "artifact"
          ? artifactLink(selectedArtifact.row)
          : props.upstream?.namespace?.(facts, selectedArtifact.group.key);
    }
    url ??= props.upstream?.registry?.(facts);
    if (url !== undefined) commands.open(url);
  };
  return { ...context, artifactLink, openSelected };
}

function useNavigation(context: ReturnType<typeof useLinks>) {
  const { state, setAccountId, view, setView, reload, tabs, move } = context;
  const nextAccount = (): void => {
    const index = state.accounts.findIndex((row) => row.id === state.account?.id);
    const next = state.accounts[(index + 1) % Math.max(1, state.accounts.length)];
    if (next !== undefined) {
      setAccountId(next.id);
      void reload(next.id);
    }
  };

  const goToView = (delta: number): void => {
    const index = tabs.findIndex((tab) => tab.id === view);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next !== undefined) setView(next.id);
  };

  /** Movement, which every list-shaped view shares. */
  const onNavKey = (input: string, key: Key): boolean => {
    // Left and right walk the tabs; folding a group is `enter` on its header.
    if (key.leftArrow) {
      goToView(-1);
      return true;
    }
    if (key.rightArrow) {
      goToView(1);
      return true;
    }
    const delta =
      key.upArrow || input === "k"
        ? -1
        : key.downArrow || input === "j"
          ? 1
          : key.pageUp
            ? -10
            : key.pageDown
              ? 10
              : 0;
    if (delta === 0) return false;
    move(delta);
    return true;
  };
  return { ...context, nextAccount, goToView, onNavKey };
}

function useGlobalKeys(context: ReturnType<typeof useNavigation>) {
  const {
    exit,
    state,
    setAccountId,
    setOverlay,
    reload,
    run,
    openSelected,
    nextAccount,
    onNavKey,
  } = context;
  /** Keys every view answers to. Returns false when the view should try it. */
  const onGlobalKey = (input: string, key: Key): boolean => {
    if (onNavKey(input, key)) return true;
    // The digits match the labels on the registry tabs. Views move with the
    // arrows, which is what their strip says.
    const numbered = state.accounts[Number(input) - 1];
    const actions: Record<string, () => void> = {
      q: exit,
      "?": () => setOverlay({ kind: "help" }),
      g: () => void reload(),
      o: openSelected,
      u: () => run("pull latest", commands.pullLatest(state.account?.registry, state.scope)),
    };
    if (key.ctrl && input === "c") {
      exit();
      return true;
    }
    if (key.tab) {
      nextAccount();
      return true;
    }
    if (numbered !== undefined && input >= "1" && input <= "9") {
      if (numbered.id !== state.account?.id) {
        setAccountId(numbered.id);
        void reload(numbered.id);
      }
      return true;
    }
    const chosen = actions[input];
    if (chosen === undefined) return false;
    chosen();
    return true;
  };
  return { ...context, onGlobalKey };
}

function useOverlayKeys(context: ReturnType<typeof useGlobalKeys>) {
  const {
    state,
    setFilter,
    setFiltering,
    overlay,
    setOverlay,
    run,
    planForRow,
    importNow,
    artifactLink,
    onNavKey,
  } = context;
  /** While the filter is open it owns the keyboard, or typing "p" publishes. */
  const onFilterKey = (input: string, key: Key): void => {
    // The cursor still moves while you type, so a filter can be narrowed and
    // walked without closing it first.
    if (onNavKey(input, key)) return;
    if (key.escape) {
      setFiltering(false);
      setFilter("");
      return;
    }
    if (key.return) {
      setFiltering(false);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1));
      return;
    }
    if (input !== "" && !key.ctrl && !key.meta) setFilter((current) => current + input);
  };

  const publishFromDetail = (row: ArtifactRow): void => {
    const plan = importNow(row) ? undefined : planForRow(row);
    setOverlay(plan === undefined ? { kind: "none" } : { kind: "publish", plan });
  };

  const onOverlayKey = (input: string, key: Key): void => {
    if (key.escape || input === "q") {
      setOverlay({ kind: "none" });
      return;
    }
    if (overlay.kind === "publish" && key.return) {
      const plan = overlay.plan;
      setOverlay({ kind: "none" });
      if (plan.send.length > 0) {
        run(
          `publishing ${plan.send.length}`,
          commands.publish(
            plan.send.map(selector),
            plan.alias === undefined ? undefined : plan.namespace,
            state.scope,
          ),
        );
      }
      return;
    }
    if (overlay.kind !== "detail") return;
    if (input === "p") {
      publishFromDetail(overlay.row);
      return;
    }
    if (input === "o") {
      const url = artifactLink(overlay.row);
      if (url !== undefined) commands.open(url);
    }
  };
  return { ...context, onFilterKey, publishFromDetail, onOverlayKey };
}

function useViewKeys(context: ReturnType<typeof useOverlayKeys>) {
  const {
    state,
    view,
    setView,
    setCursors,
    folded,
    setFolded,
    setFilter,
    setFiltering,
    setFlags,
    setOverlay,
    reload,
    panel,
    cursor,
    panelView,
    selectedArtifact,
    selectedJob,
    run,
    importNow,
    publishPlan,
  } = context;
  /** aireg never publishes to a git registry; its rows already say where an edit goes. */
  const publishSelected = (): void => {
    if (state.account?.publishes === false) return;
    if (selectedArtifact?.kind === "artifact" && importNow(selectedArtifact.row)) return;
    const plan = publishPlan(selectedArtifact);
    if (plan !== undefined) setOverlay({ kind: "publish", plan });
  };

  const onArtifactsKey = (input: string, key: Key): void => {
    if (input === "/") {
      setFiltering(true);
      return;
    }
    if (input === "p") {
      publishSelected();
      return;
    }
    if (key.return && selectedArtifact?.kind === "artifact") {
      setOverlay({ kind: "detail", row: selectedArtifact.row });
      return;
    }
    const group = selectedArtifact?.group;
    if (group === undefined) return;
    const fold = input === "h" ? true : input === "l" ? false : !folded.has(group.key);
    if (input !== "h" && input !== "l" && !key.return) return;
    setFolded((current) => {
      const next = new Set(current);
      if (fold) next.add(group.key);
      else next.delete(group.key);
      return next;
    });
  };

  const onJobsKey = (input: string): void => {
    if (selectedJob?.kind === "job") {
      const job = selectedJob.job;
      if (input === "R") {
        run(`running ${job.id}`, commands.runJob(job.id));
        return;
      }
      if (input === " ") {
        run(
          `${job.enabled ? "disabling" : "enabling"} ${job.id}`,
          commands.setJobEnabled(job.id, !job.enabled),
        );
        return;
      }
    }
    if (selectedJob?.kind === "run" && input === "r") {
      run(`retrying ${selectedJob.run.id}`, commands.retryRun(selectedJob.run.id));
    }
  };

  /** Enter on a namespace opens it in Artifacts, with only that group shown. */
  const onOverviewKey = (key: Key): void => {
    if (!key.return) return;
    const group = state.groups[cursor];
    if (group === undefined) return;
    setFilter(group.authoredHere ? "" : group.key);
    setView("artifacts");
    setCursors((current) => ({ ...current, artifacts: 0 }));
  };

  /** A contributed tab's keys. It gets the console's verbs, not its state. */
  const onPanelKey = (input: string): void => {
    if (panel?.onKey === undefined || panelView === undefined) return;
    panel.onKey(input, {
      view: panelView,
      setFlag: (name, value) =>
        setFlags((current) => ({ ...current, [view]: { ...current[view], [name]: value } })),
      run,
      open: commands.open,
      reload: () => void reload(),
    });
  };
  return { ...context, publishSelected, onArtifactsKey, onJobsKey, onOverviewKey, onPanelKey };
}

function useMouseInteractions(context: ReturnType<typeof useViewKeys>) {
  const {
    state,
    setAccountId,
    view,
    setView,
    setCursors,
    overlay,
    activity,
    reload,
    tabs,
    panel,
    jobs,
    listHeight,
    length,
    cursor,
    move,
  } = context;
  /** A click on the tab strips, which is the only chrome that is clickable. */
  const clickedTab = (event: MouseEvent): boolean => {
    if (event.row === LAYOUT.viewTabs) {
      const index = tabAt(event.column, viewTabWidths(tabs), 0);
      const next = index === undefined ? undefined : tabs[index];
      if (next !== undefined) setView(next.id);
      return true;
    }
    if (event.row !== LAYOUT.accountTabs) return false;
    const index = tabAt(event.column, accountTabWidths(state.accounts), 0);
    const next = index === undefined ? undefined : state.accounts[index];
    if (next !== undefined && next.id !== state.account?.id) {
      setAccountId(next.id);
      void reload(next.id);
    }
    return true;
  };

  /** Which row of the current list a click at this screen row belongs to. */
  const rowAt = (screenRow: number): number | undefined => {
    const total = length;
    if (total === 0) return undefined;
    if (view === "jobs") {
      const runs = runWindow(jobs, cursor, listHeight);
      const index = jobsIndexAt(screenRow, state.jobs.length, runs.from);
      return index !== undefined && index < total ? index : undefined;
    }
    const top = listTop(view, panel?.listTop);
    if (top === undefined) return undefined;
    const window = windowAround(total, cursor, listHeight);
    const index = window.from + (screenRow - top);
    return index >= window.from && index < window.to ? index : undefined;
  };

  /**
   * A click lands on a rendered row, and the views lay out in a fixed order,
   * so the row is turned back into a cursor position rather than measured.
   */
  const onMouse = (event: MouseEvent): void => {
    if (event.kind === "wheel-up" || event.kind === "wheel-down") {
      move(event.kind === "wheel-up" ? -3 : 3);
      return;
    }
    if (event.kind !== "press" || overlay.kind !== "none" || activity !== undefined) return;
    if (clickedTab(event)) return;
    const index = rowAt(event.row);
    if (index !== undefined) setCursors((current) => ({ ...current, [view]: index }));
  };

  useMouse(onMouse);
  return { ...context, clickedTab, rowAt, onMouse };
}

function useConsoleInput(context: ReturnType<typeof useMouseInteractions>) {
  const {
    view,
    filtering,
    overlay,
    activity,
    setActivity,
    panel,
    onGlobalKey,
    onFilterKey,
    onOverlayKey,
    onArtifactsKey,
    onJobsKey,
    onOverviewKey,
    onPanelKey,
  } = context;
  useInput((input, key) => {
    if (filtering) {
      onFilterKey(input, key);
      return;
    }
    if (activity !== undefined) {
      if (key.escape || input === "q") {
        if (activity.done) setActivity(undefined);
        else activity.cancel();
      }
      return;
    }
    if (overlay.kind !== "none") {
      onOverlayKey(input, key);
      return;
    }
    if (onGlobalKey(input, key)) return;
    if (panel !== undefined) onPanelKey(input);
    else if (view === "overview") onOverviewKey(key);
    else if (view === "artifacts") onArtifactsKey(input, key);
    else if (view === "jobs") onJobsKey(input);
  });
  return { ...context };
}

function drawBody(context: ReturnType<typeof useConsoleInput>) {
  const {
    props,
    width,
    state,
    view,
    folded,
    filter,
    filtering,
    flags,
    nowMs,
    panel,
    artifacts,
    jobs,
    listHeight,
    panelViewAt,
    cursor,
    panelView,
    selectedArtifact,
    selectedJob,
  } = context;
  const lastPull = state.runs.find((row) => row.mode === "sync")?.requestedAtMs;

  /** A contributed block per panel, for the two views that aggregate. */
  const blocks = (pick: "overview" | "settings"): ReactNode[] =>
    props.panels.flatMap((contribution) => {
      const data = state.panels[contribution.id];
      const draw = contribution[pick];
      if (draw === undefined || data === undefined) return [];
      const node = attempt(contribution.label, () =>
        draw({ ...panelViewAt(0), data, flags: flags[contribution.id] ?? {} }),
      );
      return node === undefined || node === null ? [] : [node];
    });

  const body = (): ReactNode => {
    if (panel !== undefined && panelView === undefined) {
      return unreadable(
        panel.label,
        state.problems.find((p) => p.startsWith(`${panel.label}: `)),
      );
    }
    if (panel !== undefined && panelView !== undefined) {
      return attempt(panel.label, () => panel.render(panelView));
    }
    if (view === "overview")
      return overviewView({ width, state, cursor, extra: blocks("overview") });
    if (view === "artifacts") {
      return box(
        { flexDirection: "column" },
        artifactsView({
          width,
          height: listHeight,
          state,
          lines: artifacts.lines,
          shown: artifacts.shown,
          cursor,
          folded,
          filter,
          filtering,
          nowMs,
        }),
      );
    }
    if (view === "jobs") {
      return jobsView({ width, height: listHeight, state, lines: jobs, cursor });
    }
    if (view === "accounts") return accountsView({ width, state, cursor });
    return settingsView({ width, state, cursor, extra: blocks("settings") });
  };

  const strip = (): ReactNode => {
    if (panel !== undefined && panelView !== undefined) {
      return attempt(panel.label, () => panel.strip?.(panelView) ?? null);
    }
    if (view === "artifacts") return artifactsSummary({ width, line: selectedArtifact, nowMs });
    if (view === "jobs") return jobsSummaryStrip({ width, line: selectedJob, nowMs });
    return null;
  };
  return { ...context, lastPull, blocks, body, strip };
}

function drawFrame(context: ReturnType<typeof drawBody>) {
  const {
    props,
    width,
    height,
    state,
    view,
    overlay,
    activity,
    busy,
    nowMs,
    live,
    app,
    tabs,
    panel,
    artifactLink,
    lastPull,
    body,
    strip,
  } = context;
  const overlayNode = (): ReactNode => {
    if (activity !== undefined) {
      return activityPanel({
        width,
        label: activity.label,
        command: activity.command.display,
        lines: activity.lines,
        done: activity.done,
        code: activity.code,
        progress: describe(live),
        elapsedMs: nowMs - activity.startedAtMs,
        changed: activity.changed,
      });
    }
    if (overlay.kind === "help") return helpPanel(width, panelKeys);
    if (overlay.kind === "detail") {
      return artifactDetail({ width, row: overlay.row, url: artifactLink(overlay.row), app });
    }
    if (overlay.kind === "publish") return publishConfirm({ width, plan: overlay.plan });
    return null;
  };

  // Only the keys a panel declares, so the footer never offers one it cannot answer.
  const panelKeys = panel?.keys ?? [];
  const footerKeys = [
    ...(FOOTER[view] ?? PANEL_FOOTER),
    ...panelKeys,
    ...(props.upstream === undefined ? [] : [{ key: "o", label: `open in ${app}` }]),
  ];

  const overlaid = overlayNode();

  // The console owns the whole screen: the body takes whatever the chrome does
  // not, and is cut rather than squeezing the chrome when it has more to show.
  const fixed = (node: ReactNode) => box({ flexDirection: "column", flexShrink: 0 }, node);
  return box(
    { flexDirection: "column", width, height },
    fixed(
      header({
        width,
        activity:
          activity === undefined
            ? undefined
            : {
                label: activity.label,
                line: describe(live) ?? activity.lines.at(-1),
                done: activity.done,
                failed: activity.code !== undefined && activity.code !== 0,
              },
        lastPullAtMs: lastPull,
        daemonRunning: state.daemon.running,
        read: busy ? "reading…" : `read ${clock(state.readAtMs)}`,
      }),
    ),
    fixed(
      accountTabs({
        width,
        accounts: state.accounts,
        activeId: state.account?.id,
        root: underHome(state.root),
      }),
    ),
    fixed(viewTabs(tabs, view)),
    box(
      { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      fixed(overlaid === null ? body() : overlaid),
    ),
    fixed(overlaid === null ? strip() : plain("")),
    fixed(footer({ width, keys: footerKeys, right: `v${state.version}` })),
  );
}

export function App(props: AppProps): ReactElement {
  const session = useSession(props);
  const views = useViews(session);
  const commands = useCommands(views);
  const links = useLinks(commands);
  const navigation = useNavigation(links);
  const globalKeys = useGlobalKeys(navigation);
  const overlayKeys = useOverlayKeys(globalKeys);
  const viewKeys = useViewKeys(overlayKeys);
  const mouse = useMouseInteractions(viewKeys);
  const input = useConsoleInput(mouse);
  const body = drawBody(input);
  return drawFrame(body);
}

/** A contributed tab's footer is movement plus whatever keys it declares. */
const PANEL_FOOTER: { key: string; label: string }[] = [
  { key: "up/down", label: "move" },
  { key: "left/right", label: "view" },
  { key: "g", label: "reload" },
];

const FOOTER: Record<string, { key: string; label: string }[]> = {
  overview: [
    { key: "left/right", label: "view" },
    { key: "1-9 / tab", label: "registry" },
    { key: "u", label: "pull latest" },
    { key: "g", label: "reload" },
    { key: "?", label: "keys" },
    { key: "q", label: "quit" },
  ],
  artifacts: [
    { key: "up/down", label: "move" },
    { key: "left/right", label: "view" },
    { key: "1-9", label: "registry" },
    { key: "h/l", label: "fold" },
    { key: "enter", label: "detail" },
    { key: "p", label: "publish" },
    { key: "u", label: "pull latest" },
    { key: "/", label: "filter" },
  ],
  jobs: [
    { key: "up/down", label: "move" },
    { key: "R", label: "run now" },
    { key: "r", label: "retry" },
    { key: "space", label: "enable/disable" },
    { key: "g", label: "reload" },
  ],
  accounts: [
    { key: "up/down", label: "move" },
    { key: "tab", label: "next registry" },
    { key: "g", label: "reload" },
  ],
  settings: [
    { key: "up/down", label: "move" },
    { key: "g", label: "reload" },
    { key: "q", label: "quit" },
  ],
};
