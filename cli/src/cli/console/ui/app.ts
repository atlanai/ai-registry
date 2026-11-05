import { useApp, useWindowSize } from "ink";
import type { ReactElement, ReactNode } from "react";
import { useMemo, useReducer } from "react";
import type { Progress } from "#cli/console/data/state.ts";
import { BUILT_IN_SCREENS } from "#cli/console/ui/views/built-in.ts";
import { underHome } from "#cli/render/home.ts";
import type { ConsoleState } from "#core/console/model.ts";
import type { HostCommandContext } from "#core/host/extend.ts";
import type { LinkFacts, UpstreamContribution } from "#core/host/panel.ts";
import { clock } from "#core/term/format.ts";
import { accountTabs, footer, header, type Tab, tabsWith, viewTabs } from "./chrome.ts";
import { box, plain } from "./elements.ts";
import { footerKeys, helpKeys } from "./keymap.ts";
import { activityPanel, artifactDetail, helpPanel, publishConfirm } from "./overlays.ts";
import { panelBlocks, panelScreen } from "./panel-screen.ts";
import { INITIAL_UI, reduceUi } from "./reducer.ts";
import type { Screen, ViewActions, ViewFrame } from "./screen.ts";
import { useClock } from "./use-clock.ts";
import { useCommands } from "./use-commands.ts";
import { useConsoleData, usePanelPrefetch } from "./use-data.ts";
import { useKeyboard } from "./use-keyboard.ts";
import { usePointer } from "./use-pointer.ts";
import { type AnyPanel, viewOf } from "./view.ts";

export interface AppProps {
  context: HostCommandContext;
  initial: ConsoleState;
  /** Already loaded so the render stays sync. */
  panels: readonly AnyPanel[];
  upstream: UpstreamContribution | undefined;
  /** Resolved once per account by the upstream, for links that scope by viewer. */
  viewer: string | undefined;
}

export function App(props: AppProps): ReactElement {
  const { exit } = useApp();
  const { width, height } = useSize();
  const [ui, dispatch] = useReducer(reduceUi, INITIAL_UI);
  const data = useConsoleData(props.context, props.initial);
  const running = ui.activity !== undefined && !ui.activity.done;
  const { run, live } = useCommands({ context: props.context, data, dispatch, running });
  const nowMs = useClock(running);
  const { state } = data;
  const facts: LinkFacts = useMemo(
    () => ({
      location: state.account?.address ?? "",
      config: state.account?.config ?? {},
      viewer: props.viewer,
    }),
    [state, props.viewer],
  );
  const tabs = useMemo(() => tabsWith(props.panels), [props.panels]);

  const frame: ViewFrame = {
    width,
    // Rows left after the header, tabs, list heading, summary strip and footer.
    height: Math.max(4, height - 16),
    state,
    ui,
    nowMs,
    facts,
    upstream: props.upstream,
    blocks: (pick) => panelBlocks(props.panels, frame, pick),
  };
  const actions: ViewActions = { dispatch, run, reload: () => void data.reload() };
  const view = viewOf(ui.view, props.panels);
  const screen =
    view.kind === "panel"
      ? panelScreen(view.panel, frame, actions)
      : BUILT_IN_SCREENS[view.id].open(frame, actions);

  usePanelPrefetch(screen.prefetch);
  useKeyboard({ frame, screen, tabs, data, dispatch, run, exit });
  usePointer({ frame, screen, tabs, data, dispatch });
  return drawFrame({ frame, screen, tabs, height, busy: data.busy, live });
}

function useSize(): { width: number; height: number } {
  const { columns, rows } = useWindowSize();
  // Ink writes a newline after each frame, so a full-height frame scrolls the header off.
  return {
    width: Math.max(80, columns),
    height: Math.max(20, rows - 1),
  };
}

interface FrameOptions {
  frame: ViewFrame;
  screen: Screen;
  tabs: readonly Tab[];
  /** The whole screen's; the frame's is what a list may draw. */
  height: number;
  busy: boolean;
  live: Progress | undefined;
}

function drawFrame(options: FrameOptions): ReactElement {
  const { frame, screen, tabs, height, busy, live } = options;
  const { width, state, ui } = frame;
  const activity = ui.activity;
  const overlaid = overlayNode(options);

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
        lastPullAtMs: state.runs.find((row) => row.mode === "sync")?.requestedAtMs,
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
    fixed(viewTabs(tabs, ui.view)),
    box(
      { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      fixed(overlaid === null ? screen.body() : overlaid),
    ),
    fixed(overlaid === null ? screen.strip() : plain("")),
    fixed(
      footer({
        width,
        keys: footerKeys(screen.footer, screen.declaredKeys, frame.upstream?.app),
        right: `v${state.version}`,
      }),
    ),
  );
}

function overlayNode({ frame, screen, live }: FrameOptions): ReactNode {
  const { width, ui, nowMs } = frame;
  const { activity, overlay } = ui;
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
  if (overlay.kind === "help") return helpPanel(width, helpKeys(screen.declaredKeys));
  if (overlay.kind === "detail") {
    return artifactDetail({
      width,
      row: overlay.row,
      url: frame.upstream?.artifact?.(frame.facts, overlay.row),
      app: frame.upstream?.app ?? "the registry",
    });
  }
  if (overlay.kind === "publish") return publishConfirm({ width, plan: overlay.plan });
  return null;
}

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
