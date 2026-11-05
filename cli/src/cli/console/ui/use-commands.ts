import { type Dispatch, useCallback, useEffect, useState } from "react";
import { type Progress, progress } from "#cli/console/data/state.ts";
import * as commands from "#core/console/actions.ts";
import { changesSince, snapshot } from "#core/console/changes.ts";
import type { HostCommandContext } from "#core/host/extend.ts";
import type { UiAction } from "./reducer.ts";
import type { ConsoleData } from "./use-data.ts";

export type RunCommand = (label: string, command: commands.Command) => void;

export interface CommandsOptions {
  context: HostCommandContext;
  data: ConsoleData;
  dispatch: Dispatch<UiAction>;
  running: boolean;
}

export function useCommands(options: CommandsOptions): {
  run: RunCommand;
  live: Progress | undefined;
} {
  const { context, data, dispatch, running } = options;
  const { latest, reload } = data;
  const run = useCallback(
    (label: string, command: commands.Command) => {
      // Read before the child starts, so the outcome is observed, not assumed.
      const before = snapshot(latest.current);
      const child = commands.start(command, latest.current.root, (line) =>
        dispatch({ type: "print-activity", line }),
      );
      dispatch({
        type: "start-activity",
        activity: {
          label,
          startedAtMs: Date.now(),
          command,
          lines: [],
          done: false,
          code: undefined,
          changed: undefined,
          cancel: child.cancel,
        },
      });
      void child.done.then(async (code) => {
        dispatch({ type: "finish-activity", code });
        const after = await reload();
        dispatch({ type: "compare-activity", changed: changesSince(before, after) });
      });
    },
    [reload, dispatch, latest],
  );
  return { run, live: useProgress(context, running) };
}

/** The child writes to the same run store, so its run record is the progress. */
function useProgress(context: HostCommandContext, running: boolean): Progress | undefined {
  const [live, setLive] = useState<Progress | undefined>(undefined);
  useEffect(() => {
    if (!running) {
      setLive(undefined);
      return;
    }
    const timer = setInterval(() => {
      void progress(context).then(setLive);
    }, 1_500);
    return () => clearInterval(timer);
  }, [running, context]);
  return live;
}
